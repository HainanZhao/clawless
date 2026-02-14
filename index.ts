import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { TelegramMessagingClient } from './messaging/telegramClient.js';
import { CronScheduler, ScheduleConfig } from './scheduler/cronScheduler.js';
import { createScheduledJobHandler } from './scheduler/scheduledJobHandler.js';
import { runPromptWithTempAcp } from './acp/tempAcpRunner.js';
import { buildPermissionResponse, noOpAcpFileOperation } from './acp/clientHelpers.js';
import { getErrorMessage } from './utils/error.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Validate required environment variables
if (!process.env.TELEGRAM_TOKEN) {
  console.error('Error: TELEGRAM_TOKEN environment variable is required');
  process.exit(1);
}

if (process.env.TELEGRAM_TOKEN.includes('your_telegram_bot_token_here') || !process.env.TELEGRAM_TOKEN.includes(':')) {
  console.error('Error: TELEGRAM_TOKEN looks invalid. Set a real token from @BotFather in your config/env.');
  process.exit(1);
}

const GEMINI_COMMAND = process.env.GEMINI_COMMAND || 'gemini';
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || '1200000', 10);
const GEMINI_NO_OUTPUT_TIMEOUT_MS = parseInt(process.env.GEMINI_NO_OUTPUT_TIMEOUT_MS || '300000', 10);
const GEMINI_APPROVAL_MODE = process.env.GEMINI_APPROVAL_MODE || 'yolo';
const GEMINI_MODEL = process.env.GEMINI_MODEL || '';
const ACP_PERMISSION_STRATEGY = process.env.ACP_PERMISSION_STRATEGY || 'allow_once';
const ACP_STREAM_STDOUT = String(process.env.ACP_STREAM_STDOUT || '').toLowerCase() === 'true';
const ACP_DEBUG_STREAM = String(process.env.ACP_DEBUG_STREAM || '').toLowerCase() === 'true';
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '60000', 10);
const ACP_PREWARM_RETRY_MS = parseInt(process.env.ACP_PREWARM_RETRY_MS || '30000', 10);
const GEMINI_KILL_GRACE_MS = parseInt(process.env.GEMINI_KILL_GRACE_MS || '5000', 10);
const AGENT_BRIDGE_HOME = process.env.AGENT_BRIDGE_HOME || path.join(os.homedir(), '.clawless');
const MEMORY_FILE_PATH = process.env.MEMORY_FILE_PATH || path.join(AGENT_BRIDGE_HOME, 'MEMORY.md');
const SCHEDULES_FILE_PATH = process.env.SCHEDULES_FILE_PATH || path.join(AGENT_BRIDGE_HOME, 'schedules.json');
const CALLBACK_CHAT_STATE_FILE_PATH = path.join(AGENT_BRIDGE_HOME, 'callback-chat-state.json');
const MEMORY_MAX_CHARS = parseInt(process.env.MEMORY_MAX_CHARS || '12000', 10);
const CALLBACK_HOST = process.env.CALLBACK_HOST || 'localhost';
const CALLBACK_PORT = parseInt(process.env.CALLBACK_PORT || '8788', 10);
const CALLBACK_AUTH_TOKEN = process.env.CALLBACK_AUTH_TOKEN || '';
const CALLBACK_MAX_BODY_BYTES = parseInt(process.env.CALLBACK_MAX_BODY_BYTES || '65536', 10);

// Typing indicator refresh interval (Telegram typing state expires quickly)
const TYPING_INTERVAL_MS = parseInt(process.env.TYPING_INTERVAL_MS || '4000', 10);
const TELEGRAM_STREAM_UPDATE_INTERVAL_MS = 1000;
const MESSAGE_GAP_THRESHOLD_MS = 5000; // Start a new message if gap between chunks > 5s

// Maximum response length to prevent memory issues (Telegram has 4096 char limit anyway)
const MAX_RESPONSE_LENGTH = parseInt(process.env.MAX_RESPONSE_LENGTH || '4000', 10);

// Parse Telegram whitelist from environment variable
// Expected format: JSON array of usernames (e.g., ["user1", "user2"])
function parseWhitelistFromEnv(envValue: string): string[] {
  if (!envValue || envValue.trim() === '') {
    return [];
  }

  try {
    const parsed = JSON.parse(envValue);
    if (Array.isArray(parsed)) {
      return parsed.map((name) => String(name).trim().replace(/^@/, '')).filter(Boolean);
    }
  } catch {
    console.warn('Warning: TELEGRAM_WHITELIST must be a valid JSON array of usernames (e.g., ["user1", "user2"])');
  }

  return [];
}

const TELEGRAM_WHITELIST: string[] = parseWhitelistFromEnv(process.env.TELEGRAM_WHITELIST || '');

function isUserAuthorized(username: string | undefined): boolean {
  // If whitelist is empty, block all users by default (safe default)
  if (TELEGRAM_WHITELIST.length === 0) {
    return false;
  }

  if (!username) {
    return false;
  }

  const normalizedUsername = username.toLowerCase();

  return TELEGRAM_WHITELIST.some(entry => entry.toLowerCase() === normalizedUsername);
}

const messagingClient = new TelegramMessagingClient({
  token: process.env.TELEGRAM_TOKEN,
  typingIntervalMs: TYPING_INTERVAL_MS,
  maxMessageLength: MAX_RESPONSE_LENGTH,
});

let geminiProcess: any = null;
let acpConnection: any = null;
let acpSessionId: any = null;
let acpInitPromise: Promise<void> | null = null;
let activePromptCollector: any = null;
let manualAbortRequested = false;
let messageSequence = 0;
let acpPrewarmRetryTimer: NodeJS.Timeout | null = null;
let geminiStderrTail = '';
let callbackServer: http.Server | null = null;
let lastIncomingChatId: string | null = null;
const GEMINI_STDERR_TAIL_MAX = 4000;

function validateGeminiCommandOrExit() {
  const result = spawnSync(GEMINI_COMMAND, ['--version'], {
    stdio: 'ignore',
    timeout: 10000,
    killSignal: 'SIGKILL',
  });

  if ((result as any).error?.code === 'ENOENT') {
    console.error(`Error: GEMINI_COMMAND executable not found: ${GEMINI_COMMAND}`);
    console.error('Install Gemini CLI or set GEMINI_COMMAND to a valid executable path.');
    process.exit(1);
  }

  if ((result as any).error) {
    console.error(`Error: failed to execute GEMINI_COMMAND (${GEMINI_COMMAND}):`, (result as any).error.message);
    process.exit(1);
  }
}

function terminateProcessGracefully(
  childProcess: ChildProcessWithoutNullStreams,
  processLabel: string,
  details?: Record<string, unknown>,
) {
  return new Promise<void>((resolve) => {
    if (!childProcess || childProcess.killed || childProcess.exitCode !== null) {
      resolve();
      return;
    }

    let settled = false;

    const finalize = (reason: string) => {
      if (settled) {
        return;
      }
      settled = true;
      logInfo('Gemini process termination finalized', {
        processLabel,
        reason,
        pid: childProcess.pid,
        ...details,
      });
      resolve();
    };

    childProcess.once('exit', () => finalize('exit'));

    logInfo('Sending SIGTERM to Gemini process', {
      processLabel,
      pid: childProcess.pid,
      graceMs: GEMINI_KILL_GRACE_MS,
      ...details,
    });
    childProcess.kill('SIGTERM');

    setTimeout(() => {
      if (settled || childProcess.killed || childProcess.exitCode !== null) {
        finalize('already-exited');
        return;
      }

      logInfo('Escalating Gemini process termination to SIGKILL', {
        processLabel,
        pid: childProcess.pid,
        ...details,
      });

      childProcess.kill('SIGKILL');
      finalize('sigkill');
    }, Math.max(0, GEMINI_KILL_GRACE_MS));
  });
}

const handleScheduledJob = createScheduledJobHandler({
  logInfo,
  buildPromptWithMemory,
  runScheduledPromptWithTempAcp,
  resolveTargetChatId: () => resolveChatId(lastIncomingChatId),
  sendTextToChat: (chatId, text) => messagingClient.sendTextToChat(chatId, text),
  normalizeOutgoingText,
});

const cronScheduler = new CronScheduler(handleScheduledJob, {
  persistenceFilePath: SCHEDULES_FILE_PATH,
  timezone: process.env.TZ || 'UTC',
  logInfo,
});

function ensureBridgeHomeDirectory() {
  fs.mkdirSync(AGENT_BRIDGE_HOME, { recursive: true });
}

function loadPersistedCallbackChatId() {
  try {
    if (!fs.existsSync(CALLBACK_CHAT_STATE_FILE_PATH)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(CALLBACK_CHAT_STATE_FILE_PATH, 'utf8'));
    return resolveChatId(parsed?.chatId);
  } catch (error: any) {
    logInfo('Failed to load callback chat state', {
      callbackChatStateFilePath: CALLBACK_CHAT_STATE_FILE_PATH,
      error: getErrorMessage(error),
    });
    return null;
  }
}

function persistCallbackChatId(chatId: string) {
  try {
    ensureBridgeHomeDirectory();
    fs.writeFileSync(
      CALLBACK_CHAT_STATE_FILE_PATH,
      `${JSON.stringify({ chatId: String(chatId), updatedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
  } catch (error: any) {
    logInfo('Failed to persist callback chat state', {
      callbackChatStateFilePath: CALLBACK_CHAT_STATE_FILE_PATH,
      error: getErrorMessage(error),
    });
  }
}

function logInfo(message: string, details?: unknown) {
  const timestamp = new Date().toISOString();
  if (details !== undefined) {
    console.log(`[${timestamp}] ${message}`, details);
    return;
  }
  console.log(`[${timestamp}] ${message}`);
}

function appendGeminiStderrTail(text: string) {
  geminiStderrTail = `${geminiStderrTail}${text}`;
  if (geminiStderrTail.length > GEMINI_STDERR_TAIL_MAX) {
    geminiStderrTail = geminiStderrTail.slice(-GEMINI_STDERR_TAIL_MAX);
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function isCallbackAuthorized(req: http.IncomingMessage) {
  if (!CALLBACK_AUTH_TOKEN) {
    return true;
  }

  const headerToken = req.headers['x-callback-token'];
  const authHeader = req.headers.authorization;
  const bearerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : null;

  return headerToken === CALLBACK_AUTH_TOKEN || bearerToken === CALLBACK_AUTH_TOKEN;
}

function readRequestBody(req: http.IncomingMessage, maxBytes: number) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Payload too large (>${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', (error: Error) => {
      reject(error);
    });
  });
}

function resolveChatId(value: unknown) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

  if (/^-?\d+$/.test(normalized)) {
    return normalized;
  }

  return normalized;
}

function hasActiveAcpPrompt() {
  return Boolean(activePromptCollector && acpConnection && acpSessionId);
}

function normalizeCommandText(text: unknown) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[!?.]+$/g, '');
}

function isAbortCommand(text: unknown) {
  const normalized = normalizeCommandText(text);
  if (!normalized) {
    return false;
  }

  const commands = new Set(['abort', 'cancel', 'stop', '/abort', '/cancel', '/stop']);
  if (commands.has(normalized)) {
    return true;
  }

  const compact = normalized.replace(/\s+/g, ' ');
  return compact === 'please abort' || compact === 'please cancel' || compact === 'please stop';
}

function normalizeOutgoingText(text: unknown) {
  const normalized = String(text || '').trim();
  return normalized;
}

async function handleSchedulerRequest(req: http.IncomingMessage, res: http.ServerResponse, requestUrl: URL) {
  if (!isCallbackAuthorized(req)) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  // POST /api/schedule - Create a new schedule
  if (requestUrl.pathname === '/api/schedule' && req.method === 'POST') {
    try {
      const bodyText = await readRequestBody(req, CALLBACK_MAX_BODY_BYTES);
      const body = bodyText ? JSON.parse(bodyText) : {};

      // Validate required fields
      if (!body.message || typeof body.message !== 'string') {
        sendJson(res, 400, { ok: false, error: 'Field `message` is required and must be a string' });
        return;
      }

      // Validate optional string fields
      if (body.description !== undefined && typeof body.description !== 'string') {
        sendJson(res, 400, { ok: false, error: 'Field `description` must be a string' });
        return;
      }

      if (body.cronExpression !== undefined && typeof body.cronExpression !== 'string') {
        sendJson(res, 400, { ok: false, error: 'Field `cronExpression` must be a string' });
        return;
      }

      // Parse runAt date if provided
      let runAt: Date | undefined;
      if (body.runAt) {
        runAt = new Date(body.runAt);
        if (isNaN(runAt.getTime())) {
          sendJson(res, 400, { ok: false, error: 'Invalid date format for `runAt`' });
          return;
        }
      }

      const schedule = cronScheduler.createSchedule({
        message: body.message,
        description: body.description,
        cronExpression: body.cronExpression,
        oneTime: body.oneTime === true,
        runAt,
      });

      logInfo('Schedule created', { scheduleId: schedule.id });
      sendJson(res, 201, { ok: true, schedule });
    } catch (error: any) {
      logInfo('Failed to create schedule', { error: getErrorMessage(error) });
      sendJson(res, 400, { ok: false, error: getErrorMessage(error, 'Failed to create schedule') });
    }
    return;
  }

  // GET /api/schedule - List all schedules
  if (requestUrl.pathname === '/api/schedule' && req.method === 'GET') {
    try {
      const schedules = cronScheduler.listSchedules();
      sendJson(res, 200, { ok: true, schedules });
    } catch (error: any) {
      sendJson(res, 500, { ok: false, error: getErrorMessage(error, 'Failed to list schedules') });
    }
    return;
  }

  // GET /api/schedule/:id - Get a specific schedule
  const getScheduleMatch = requestUrl.pathname.match(/^\/api\/schedule\/([^/]+)$/);
  if (getScheduleMatch && req.method === 'GET') {
    try {
      const scheduleId = getScheduleMatch[1];
      const schedule = cronScheduler.getSchedule(scheduleId);
      if (!schedule) {
        sendJson(res, 404, { ok: false, error: 'Schedule not found' });
        return;
      }
      sendJson(res, 200, { ok: true, schedule });
    } catch (error: any) {
      sendJson(res, 500, { ok: false, error: getErrorMessage(error, 'Failed to get schedule') });
    }
    return;
  }

  // DELETE /api/schedule/:id - Delete a schedule
  const deleteScheduleMatch = requestUrl.pathname.match(/^\/api\/schedule\/([^/]+)$/);
  if (deleteScheduleMatch && req.method === 'DELETE') {
    try {
      const scheduleId = deleteScheduleMatch[1];
      const removed = cronScheduler.removeSchedule(scheduleId);
      if (!removed) {
        sendJson(res, 404, { ok: false, error: 'Schedule not found' });
        return;
      }
      logInfo('Schedule removed', { scheduleId });
      sendJson(res, 200, { ok: true, message: 'Schedule removed' });
    } catch (error: any) {
      sendJson(res, 500, { ok: false, error: getErrorMessage(error, 'Failed to remove schedule') });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
}

async function handleCallbackRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const hostHeader = req.headers.host || `${CALLBACK_HOST}:${CALLBACK_PORT}`;
  const requestUrl = new URL(req.url || '/', `http://${hostHeader}`);

  // Health check endpoint
  if (requestUrl.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Scheduler endpoints
  if (requestUrl.pathname.startsWith('/api/schedule')) {
    await handleSchedulerRequest(req, res, requestUrl);
    return;
  }

  // Original callback/telegram endpoint
  if (requestUrl.pathname !== '/callback/telegram') {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  if (!isCallbackAuthorized(req)) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  let body: any = null;
  try {
    const bodyText = await readRequestBody(req, CALLBACK_MAX_BODY_BYTES);
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch (error: any) {
    sendJson(res, 400, { ok: false, error: getErrorMessage(error, 'Invalid JSON body') });
    return;
  }

  const callbackText = normalizeOutgoingText(body?.text);
  if (!callbackText) {
    sendJson(res, 400, { ok: false, error: 'Field `text` is required' });
    return;
  }

  const targetChatId = resolveChatId(
    body?.chatId
    ?? requestUrl.searchParams.get('chatId')
    ?? lastIncomingChatId,
  );

  if (!targetChatId) {
    sendJson(res, 400, {
      ok: false,
      error: 'No chat id available. Send one Telegram message to the bot once to bind a target chat, or provide `chatId` in this callback request.',
    });
    return;
  }

  try {
    await messagingClient.sendTextToChat(targetChatId, callbackText);
    logInfo('Callback message sent', { targetChatId });
    sendJson(res, 200, { ok: true, chatId: targetChatId });
  } catch (error: any) {
    sendJson(res, 500, { ok: false, error: getErrorMessage(error, 'Failed to send Telegram message') });
  }
}

function startCallbackServer() {
  if (callbackServer) {
    return;
  }

  callbackServer = http.createServer((req, res) => {
    handleCallbackRequest(req, res).catch((error: any) => {
      sendJson(res, 500, { ok: false, error: getErrorMessage(error, 'Internal callback server error') });
    });
  });

  callbackServer.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logInfo('Callback server port already in use; skipping local callback listener for this process', {
        host: CALLBACK_HOST,
        port: CALLBACK_PORT,
      });
      callbackServer?.close();
      callbackServer = null;
      return;
    }

    console.error('Callback server error:', error);
  });

  callbackServer.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
    logInfo('Callback server listening', {
      host: CALLBACK_HOST,
      port: CALLBACK_PORT,
      authEnabled: Boolean(CALLBACK_AUTH_TOKEN),
      endpoint: '/callback/telegram',
    });
  });
}

function stopCallbackServer() {
  if (!callbackServer) {
    return;
  }

  callbackServer.close();
  callbackServer = null;
}

async function cancelActiveAcpPrompt() {
  try {
    if (acpConnection && acpSessionId) {
      await acpConnection.cancel({ sessionId: acpSessionId });
    }
  } catch (_) {
  }
}

async function shutdownAcpRuntime(reason: string) {
  const processToStop = geminiProcess;
  const runtimeSessionId = acpSessionId;

  activePromptCollector = null;
  acpConnection = null;
  acpSessionId = null;
  acpInitPromise = null;
  geminiProcess = null;
  geminiStderrTail = '';

  if (processToStop && !processToStop.killed && processToStop.exitCode === null) {
    await terminateProcessGracefully(processToStop, 'main-acp-runtime', {
      reason,
      sessionId: runtimeSessionId,
    });
  }
}

function setupGracefulShutdown() {
  const shutdownSignals = ['SIGINT', 'SIGTERM'];

  for (const signal of shutdownSignals) {
    process.once(signal, () => {
      console.log(`Received ${signal}, stopping bot...`);
      cronScheduler.shutdown();
      stopCallbackServer();
      messagingClient.stop(signal);
      void shutdownAcpRuntime(`signal:${signal}`);
    });
  }
}

function ensureMemoryFile() {
  ensureBridgeHomeDirectory();
  fs.mkdirSync(path.dirname(MEMORY_FILE_PATH), { recursive: true });

  if (!fs.existsSync(MEMORY_FILE_PATH)) {
    const template = [
      '# Clawless Memory',
      '',
      'This file stores durable memory notes for Clawless.',
      '',
      '## Notes',
      '',
    ].join('\n');
    fs.writeFileSync(MEMORY_FILE_PATH, `${template}\n`, 'utf8');
    logInfo('Created memory file', { memoryFilePath: MEMORY_FILE_PATH });
  }
}

function readMemoryContext() {
  try {
    const content = fs.readFileSync(MEMORY_FILE_PATH, 'utf8');
    if (content.length <= MEMORY_MAX_CHARS) {
      return content;
    }
    return content.slice(-MEMORY_MAX_CHARS);
  } catch (error: any) {
    logInfo('Unable to read memory file; continuing without memory context', {
      memoryFilePath: MEMORY_FILE_PATH,
      error: getErrorMessage(error),
    });
    return '';
  }
}

function buildPromptWithMemory(userPrompt: string) {
  const memoryContext = readMemoryContext() || '(No saved memory yet)';
  const callbackEndpoint = `http://${CALLBACK_HOST}:${CALLBACK_PORT}/callback/telegram`;
  const scheduleEndpoint = `http://${CALLBACK_HOST}:${CALLBACK_PORT}/api/schedule`;

  return [
    'System instruction:',
    `- Persistent memory file path: ${MEMORY_FILE_PATH}`,
    '- If user asks to remember/memorize/save for later, append a concise bullet under "## Notes" in that file.',
    '- Do not overwrite existing memory entries; append only.',
    `- Callback endpoint for proactive notifications (cron/jobs): POST ${callbackEndpoint}`,
    '- Callback payload should include a JSON `text` field; `chatId` is optional.',
    `- Persisted callback chat binding file: ${CALLBACK_CHAT_STATE_FILE_PATH}`,
    '- If no `chatId` is provided, the bridge sends to the persisted bound chat.',
    '- For scheduled jobs, include callback delivery steps so results are pushed to Telegram when jobs complete.',
    '',
    '**Scheduler API:**',
    `- Create schedule: POST ${scheduleEndpoint}`,
    '  Body format for recurring: {"message": "prompt text", "description": "optional", "cronExpression": "* * * * *"}',
    '  Body format for one-time: {"message": "prompt text", "description": "optional", "oneTime": true, "runAt": "2026-12-31T23:59:59Z"}',
    '  Cron format: "minute hour day month weekday" (e.g., "0 9 * * *" = daily at 9am, "*/5 * * * *" = every 5 minutes)',
    `- List schedules: GET ${scheduleEndpoint}`,
    `- Get schedule: GET ${scheduleEndpoint}/:id`,
    `- Delete schedule: DELETE ${scheduleEndpoint}/:id`,
    '- When schedule runs, it executes the message through Gemini CLI and sends results to Telegram.',
    '- Use this API when user asks to schedule tasks, set reminders, or create recurring jobs.',
    CALLBACK_AUTH_TOKEN
      ? '- Scheduler auth is enabled: include `x-callback-token` (or bearer token) header when creating requests.'
      : '- Scheduler auth is disabled unless CALLBACK_AUTH_TOKEN is configured.',
    '',
    'Current memory context:',
    memoryContext,
    '',
    'User message:',
    userPrompt,
  ].join('\n');
}

class TelegramAcpClient {
  async requestPermission(params: any) {
    return buildPermissionResponse(params?.options, ACP_PERMISSION_STRATEGY);
  }

  async sessionUpdate(params: any) {
    if (!activePromptCollector || params.sessionId !== acpSessionId) {
      return;
    }

    activePromptCollector.onActivity();

    if (params.update?.sessionUpdate === 'agent_message_chunk' && params.update?.content?.type === 'text') {
      const chunkText = params.update.content.text;
      activePromptCollector.append(chunkText);
      if (ACP_STREAM_STDOUT && chunkText) {
        process.stdout.write(chunkText);
      }
    }
  }

  async readTextFile(_params: any) {
    return noOpAcpFileOperation(_params);
  }

  async writeTextFile(_params: any) {
    return noOpAcpFileOperation(_params);
  }
}

const acpClient = new TelegramAcpClient();

function resetAcpRuntime() {
  logInfo('Resetting ACP runtime state');
  void shutdownAcpRuntime('runtime-reset');

  scheduleAcpPrewarm('runtime reset');
}

function scheduleAcpPrewarm(reason: string) {
  if (hasHealthyAcpRuntime() || acpInitPromise) {
    return;
  }

  if (acpPrewarmRetryTimer) {
    return;
  }

  logInfo('Triggering ACP prewarm', { reason });

  ensureAcpSession()
    .then(() => {
      logInfo('Gemini ACP prewarm complete');
    })
    .catch((error: any) => {
      logInfo('Gemini ACP prewarm failed', { error: getErrorMessage(error) });
      if (ACP_PREWARM_RETRY_MS > 0) {
        acpPrewarmRetryTimer = setTimeout(() => {
          acpPrewarmRetryTimer = null;
          scheduleAcpPrewarm('retry');
        }, ACP_PREWARM_RETRY_MS);
      }
    });
}

function buildGeminiAcpArgs() {
  const args = ['--experimental-acp'];

  const includeDirectories = new Set([AGENT_BRIDGE_HOME, os.homedir()]);

  for (const includeDirectory of includeDirectories) {
    args.push('--include-directories', includeDirectory);
  }

  if (GEMINI_APPROVAL_MODE) {
    args.push('--approval-mode', GEMINI_APPROVAL_MODE);
  }

  if (GEMINI_MODEL) {
    args.push('--model', GEMINI_MODEL);
  }

  return args;
}

async function ensureAcpSession() {
  ensureMemoryFile();

  if (acpConnection && acpSessionId && geminiProcess && !geminiProcess.killed) {
    return;
  }

  if (acpInitPromise) {
    await acpInitPromise;
    return;
  }

  acpInitPromise = (async () => {
    const args = buildGeminiAcpArgs();
    logInfo('Starting Gemini ACP process', { command: GEMINI_COMMAND, args });
    geminiStderrTail = '';
    geminiProcess = spawn(GEMINI_COMMAND, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });

    geminiProcess.stderr.on('data', (chunk: Buffer) => {
      const rawText = chunk.toString();
      appendGeminiStderrTail(rawText);
      const text = rawText.trim();
      if (text) {
        console.error(`[gemini] ${text}`);
      }
      if (activePromptCollector) {
        activePromptCollector.onActivity();
      }
    });

    geminiProcess.on('error', (error: Error) => {
      console.error('Gemini ACP process error:', error.message);
      resetAcpRuntime();
    });

    geminiProcess.on('close', (code: number, signal: string) => {
      console.error(`Gemini ACP process closed (code=${code}, signal=${signal})`);
      resetAcpRuntime();
    });

    // ACP uses JSON-RPC over streams; Gemini stdio is the ACP transport here.
    const input = Writable.toWeb(geminiProcess.stdin) as unknown as WritableStream<Uint8Array>;
    const output = Readable.toWeb(geminiProcess.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    acpConnection = new acp.ClientSideConnection(() => acpClient, stream);

    try {
      await acpConnection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      logInfo('ACP connection initialized');

      const session = await acpConnection.newSession({
        cwd: process.cwd(),
        mcpServers: [],
      });

      acpSessionId = session.sessionId;
      logInfo('ACP session ready', { sessionId: acpSessionId });
    } catch (error: any) {
      const baseMessage = getErrorMessage(error);
      const isInternalError = baseMessage.includes('Internal error');
      const hint = isInternalError
        ? 'Gemini ACP newSession returned Internal error. This is often caused by a local MCP server or skill initialization issue. Try launching `gemini` directly and checking MCP/skills diagnostics.'
        : '';

      logInfo('ACP initialization failed', {
        error: baseMessage,
        stderrTail: geminiStderrTail || '(empty)',
      });

      resetAcpRuntime();
      throw new Error(hint ? `${baseMessage}. ${hint}` : baseMessage);
    }
  })();

  try {
    await acpInitPromise;
  } finally {
    acpInitPromise = null;
  }
}

function hasHealthyAcpRuntime() {
  return Boolean(acpConnection && acpSessionId && geminiProcess && !geminiProcess.killed);
}

const messageQueue: Array<any> = [];
let isQueueProcessing = false;

function enqueueMessage(messageContext: any) {
  return new Promise<void>((resolve, reject) => {
    const requestId = ++messageSequence;
    messageQueue.push({ requestId, messageContext, resolve, reject });
    logInfo('Message enqueued', { requestId, queueLength: messageQueue.length });
    processQueue().catch((error) => {
      console.error('Queue processor failed:', error);
    });
  });
}

async function processQueue() {
  if (isQueueProcessing) {
    return;
  }

  isQueueProcessing = true;
  while (messageQueue.length > 0) {
    const item = messageQueue.shift();
    if (!item) {
      continue;
    }

    try {
      logInfo('Processing queued message', { requestId: item.requestId, queueLength: messageQueue.length });
      await processSingleMessage(item.messageContext, item.requestId);
      logInfo('Message processed', { requestId: item.requestId });
      item.resolve();
    } catch (error: any) {
      logInfo('Message processing failed', { requestId: item.requestId, error: getErrorMessage(error) });
      item.reject(error);
    }
  }
  isQueueProcessing = false;
}

async function runScheduledPromptWithTempAcp(promptForGemini: string, scheduleId: string): Promise<string> {
  return runPromptWithTempAcp({
    scheduleId,
    promptForGemini,
    command: GEMINI_COMMAND,
    args: buildGeminiAcpArgs(),
    cwd: process.cwd(),
    timeoutMs: GEMINI_TIMEOUT_MS,
    noOutputTimeoutMs: GEMINI_NO_OUTPUT_TIMEOUT_MS,
    permissionStrategy: ACP_PERMISSION_STRATEGY,
    stderrTailMaxChars: GEMINI_STDERR_TAIL_MAX,
    logInfo,
  });
}

/**
 * Streams text output from Gemini CLI for a single prompt.
 */
async function runAcpPrompt(promptText: string, onChunk?: (chunk: string) => void) {
  await ensureAcpSession();
  const promptInvocationId = `telegram-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  logInfo('Starting ACP prompt', {
    invocationId: promptInvocationId,
    sessionId: acpSessionId,
    promptLength: promptText.length,
  });
  const promptForGemini = buildPromptWithMemory(promptText);

  return new Promise<string>((resolve, reject) => {
    let fullResponse = '';
    let isSettled = false;
    let noOutputTimeout: NodeJS.Timeout | null = null;
    const startedAt = Date.now();
    let chunkCount = 0;
    let firstChunkAt: number | null = null;

    const clearTimers = () => {
      clearTimeout(overallTimeout);
      if (noOutputTimeout) {
        clearTimeout(noOutputTimeout);
      }
    };

    const failOnce = (error: Error) => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      manualAbortRequested = false;
      clearTimers();
      activePromptCollector = null;
      logInfo('ACP prompt failed', {
        invocationId: promptInvocationId,
        sessionId: acpSessionId,
        chunkCount,
        firstChunkDelayMs: firstChunkAt ? firstChunkAt - startedAt : null,
        elapsedMs: Date.now() - startedAt,
        error: getErrorMessage(error),
      });
      reject(error);
    };

    const resolveOnce = (value: string) => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      manualAbortRequested = false;
      clearTimers();
      activePromptCollector = null;
      logInfo('ACP prompt completed', {
        invocationId: promptInvocationId,
        sessionId: acpSessionId,
        chunkCount,
        firstChunkDelayMs: firstChunkAt ? firstChunkAt - startedAt : null,
        elapsedMs: Date.now() - startedAt,
        responseLength: value.length,
      });
      resolve(value);
    };

    const refreshNoOutputTimer = () => {
      if (!GEMINI_NO_OUTPUT_TIMEOUT_MS || GEMINI_NO_OUTPUT_TIMEOUT_MS <= 0) {
        return;
      }

      if (noOutputTimeout) {
        clearTimeout(noOutputTimeout);
      }

      noOutputTimeout = setTimeout(async () => {
        await cancelActiveAcpPrompt();
        failOnce(new Error(`Gemini ACP produced no output for ${GEMINI_NO_OUTPUT_TIMEOUT_MS}ms`));
      }, GEMINI_NO_OUTPUT_TIMEOUT_MS);
    };

    const overallTimeout = setTimeout(async () => {
      await cancelActiveAcpPrompt();
      failOnce(new Error(`Gemini ACP timed out after ${GEMINI_TIMEOUT_MS}ms`));
    }, GEMINI_TIMEOUT_MS);

    activePromptCollector = {
      onActivity: refreshNoOutputTimer,
      append: (textChunk: string) => {
        refreshNoOutputTimer();
        chunkCount += 1;
        if (!firstChunkAt) {
          firstChunkAt = Date.now();
        }
        if (ACP_DEBUG_STREAM) {
          logInfo('ACP chunk received', {
            invocationId: promptInvocationId,
            chunkIndex: chunkCount,
            chunkLength: textChunk.length,
            elapsedMs: Date.now() - startedAt,
            bufferLengthBeforeAppend: fullResponse.length,
          });
        }
        fullResponse += textChunk;
        if (onChunk) {
          try {
            onChunk(textChunk);
          } catch (_) {
          }
        }
      },
    };

    refreshNoOutputTimer();

    acpConnection.prompt({
      sessionId: acpSessionId,
      prompt: [
        {
          type: 'text',
          text: promptForGemini,
        },
      ],
    })
      .then((result: any) => {
        if (ACP_DEBUG_STREAM) {
          logInfo('ACP prompt stop reason', {
            invocationId: promptInvocationId,
            stopReason: result?.stopReason || '(none)',
            chunkCount,
            bufferedLength: fullResponse.length,
            deliveryMode: 'telegram-live-preview-then-final',
          });
        }
        if (result?.stopReason === 'cancelled' && !fullResponse) {
          failOnce(new Error(manualAbortRequested ? 'Gemini ACP prompt was aborted by user' : 'Gemini ACP prompt was cancelled'));
          return;
        }
        resolveOnce(fullResponse || 'No response received.');
      })
      .catch((error: any) => {
        failOnce(new Error(error?.message || 'Gemini ACP prompt failed'));
      });
  });
}

async function processSingleMessage(messageContext: any, messageRequestId: number) {
  logInfo('Starting Telegram message processing', {
    requestId: messageRequestId,
    chatId: messageContext.chatId,
  });
  const stopTypingIndicator = messageContext.startTyping();
  let liveMessageId: number | undefined;
  let previewBuffer = '';
  let flushTimer: NodeJS.Timeout | null = null;
  let lastFlushAt = 0;
  let lastChunkAt = 0;
  let finalizedViaLiveMessage = false;
  let startingLiveMessage: Promise<void> | null = null;
  let promptCompleted = false;

  const clearFlushTimer = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const previewText = () => {
    if (previewBuffer.length <= MAX_RESPONSE_LENGTH) {
      return previewBuffer;
    }
    return `${previewBuffer.slice(0, MAX_RESPONSE_LENGTH - 1)}…`;
  };

  const flushPreview = async (force = false) => {
    if (!liveMessageId || finalizedViaLiveMessage) {
      return;
    }

    const now = Date.now();
    if (!force && now - lastFlushAt < TELEGRAM_STREAM_UPDATE_INTERVAL_MS) {
      return;
    }

    lastFlushAt = now;
    const text = previewText();
    if (!text) {
      return;
    }

    try {
      await messageContext.updateLiveMessage(liveMessageId, text);
      if (ACP_DEBUG_STREAM) {
        logInfo('Telegram live preview updated', {
          requestId: messageRequestId,
          previewLength: text.length,
        });
      }
    } catch (error: any) {
      const errorMessage = getErrorMessage(error).toLowerCase();
      if (!errorMessage.includes('message is not modified')) {
        logInfo('Telegram live preview update skipped', {
          requestId: messageRequestId,
          error: getErrorMessage(error),
        });
      }
    }
  };

  const scheduleFlush = () => {
    if (flushTimer) {
      return;
    }

    const dueIn = Math.max(0, TELEGRAM_STREAM_UPDATE_INTERVAL_MS - (Date.now() - lastFlushAt));
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await flushPreview(true);
    }, dueIn);
  };

  const ensureLiveMessageStarted = async () => {
    if (liveMessageId || finalizedViaLiveMessage) {
      return;
    }

    if (startingLiveMessage) {
      await startingLiveMessage;
      return;
    }

    startingLiveMessage = (async () => {
      try {
        const initialPreview = previewText() || '…';
        liveMessageId = await messageContext.startLiveMessage(initialPreview);
        lastFlushAt = Date.now();
      } catch (_) {
        liveMessageId = undefined;
      }
    })();

    try {
      await startingLiveMessage;
    } finally {
      startingLiveMessage = null;
    }
  };

  const finalizeCurrentMessage = async () => {
    if (!liveMessageId) {
      return;
    }

    // Wait for any pending message start to complete
    if (startingLiveMessage) {
      try {
        await startingLiveMessage;
      } catch (_) {
        // Ignore errors, will be handled elsewhere
      }
    }

    clearFlushTimer();
    await flushPreview(true);

    try {
      const text = previewText();
      await messageContext.finalizeLiveMessage(liveMessageId, text);
      if (ACP_DEBUG_STREAM) {
        logInfo('Finalized message due to long gap', {
          requestId: messageRequestId,
          messageLength: text.length,
        });
      }
    } catch (error: any) {
      logInfo('Failed to finalize message on gap', {
        requestId: messageRequestId,
        error: getErrorMessage(error),
      });
    }

    // Reset state to start a new message
    liveMessageId = undefined;
    previewBuffer = '';
    lastFlushAt = Date.now();
    startingLiveMessage = null;
  };

  try {
    const fullResponse = await runAcpPrompt(messageContext.text, async (chunk) => {
      const now = Date.now();
      const gapSinceLastChunk = lastChunkAt > 0 ? now - lastChunkAt : 0;

      // If gap is more than 5 seconds, finalize current message and start a new one
      if (gapSinceLastChunk > MESSAGE_GAP_THRESHOLD_MS && liveMessageId && previewBuffer) {
        await finalizeCurrentMessage();
      }

      lastChunkAt = now;
      previewBuffer += chunk;
      void ensureLiveMessageStarted();
      void scheduleFlush();
    });
    promptCompleted = true;

    clearFlushTimer();
    await flushPreview(true);

    if (startingLiveMessage) {
      try {
        await startingLiveMessage;
      } catch (_) {
      }
    }

    if (liveMessageId) {
      try {
        await messageContext.finalizeLiveMessage(liveMessageId, fullResponse || 'No response received.');
        finalizedViaLiveMessage = true;
      } catch (error: any) {
        finalizedViaLiveMessage = true;
        logInfo('Live message finalize failed; keeping streamed message as final output', {
          requestId: messageRequestId,
          error: getErrorMessage(error),
        });
      }
    }

    if (!finalizedViaLiveMessage && ACP_DEBUG_STREAM) {
      logInfo('Sending Telegram final response', {
        requestId: messageRequestId,
        responseLength: (fullResponse || '').length,
      });
    }

    if (!finalizedViaLiveMessage) {
      await messageContext.sendText(fullResponse || 'No response received.');
    }
  } finally {
    clearFlushTimer();
    if (liveMessageId && !finalizedViaLiveMessage && !promptCompleted) {
      try {
        await messageContext.removeMessage(liveMessageId);
      } catch (_) {
      }
    }
    stopTypingIndicator();
    logInfo('Finished Telegram message processing', {
      requestId: messageRequestId,
      chatId: messageContext.chatId,
    });
  }
}

/**
 * Handles incoming text messages from Telegram
 */
messagingClient.onTextMessage(async (messageContext) => {
  // Check if user is authorized
  if (!isUserAuthorized(messageContext.username)) {
    console.warn(`Unauthorized access attempt from username: ${messageContext.username ?? 'none'} (ID: ${messageContext.userId ?? 'unknown'})`);
    await messageContext.sendText('🚫 Unauthorized. This bot is restricted to authorized users only.');
    return;
  }

  if (messageContext.chatId !== undefined && messageContext.chatId !== null) {
    lastIncomingChatId = String(messageContext.chatId);
    persistCallbackChatId(lastIncomingChatId);
  }

  if (isAbortCommand(messageContext.text)) {
    if (!hasActiveAcpPrompt()) {
      await messageContext.sendText('ℹ️ No active Gemini action to abort.');
      return;
    }

    manualAbortRequested = true;
    await messageContext.sendText('⏹️ Abort requested. Stopping current Gemini action...');
    await cancelActiveAcpPrompt();
    return;
  }

  enqueueMessage(messageContext)
    .catch(async (error: any) => {
      console.error('Error processing message:', error);
      const errorMessage = getErrorMessage(error);
      if (errorMessage.toLowerCase().includes('aborted by user')) {
        await messageContext.sendText('⏹️ Gemini action stopped.');
        return;
      }
      await messageContext.sendText(`❌ Error: ${errorMessage}`);
    });
});

// Error handling
messagingClient.onError((error, messageContext) => {
  console.error('Telegram client error:', error);
  if (messageContext) {
    messageContext.sendText('⚠️ An error occurred while processing your request.').catch(() => {});
  }
});

// Graceful shutdown
setupGracefulShutdown();

// Launch the bot
logInfo('Starting Agent ACP Bridge...');
validateGeminiCommandOrExit();
ensureBridgeHomeDirectory();
ensureMemoryFile();
lastIncomingChatId = loadPersistedCallbackChatId();
if (lastIncomingChatId) {
  logInfo('Loaded callback chat binding', { chatId: lastIncomingChatId });
}
startCallbackServer();
scheduleAcpPrewarm('startup');
messagingClient.launch()
  .then(async () => {
    logInfo('Bot launched successfully', {
      typingIntervalMs: TYPING_INTERVAL_MS,
      geminiTimeoutMs: GEMINI_TIMEOUT_MS,
      geminiNoOutputTimeoutMs: GEMINI_NO_OUTPUT_TIMEOUT_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      acpPrewarmRetryMs: ACP_PREWARM_RETRY_MS,
      memoryFilePath: MEMORY_FILE_PATH,
      callbackHost: CALLBACK_HOST,
      callbackPort: CALLBACK_PORT,
      mcpSkillsSource: 'local Gemini CLI defaults (no MCP override)',
      acpMode: `${GEMINI_COMMAND} --experimental-acp`,
      telegramWhitelist: TELEGRAM_WHITELIST.length > 0 ? `${TELEGRAM_WHITELIST.length} user(s) authorized` : 'NONE (all users blocked)',
    });

    if (TELEGRAM_WHITELIST.length === 0) {
      console.warn('⚠️  WARNING: Telegram whitelist is empty. All users will be blocked.');
      console.warn('⚠️  Add usernames to TELEGRAM_WHITELIST config (as a JSON array) to authorize users.');
    } else {
      console.log(`✅ Telegram authorization enabled. Authorized usernames: ${TELEGRAM_WHITELIST.join(', ')}`);
    }

    scheduleAcpPrewarm('post-launch');

    if (HEARTBEAT_INTERVAL_MS > 0) {
      setInterval(() => {
        logInfo('Heartbeat', {
          queueLength: messageQueue.length,
          acpSessionReady: Boolean(acpSessionId),
          geminiProcessRunning: Boolean(geminiProcess && !geminiProcess.killed),
        });
      }, HEARTBEAT_INTERVAL_MS);
    }
  })
  .catch((error: any) => {
    if (error?.response?.error_code === 404 && error?.on?.method === 'getMe') {
      console.error('Failed to launch bot: Telegram token is invalid (getMe returned 404 Not Found).');
      console.error('Update TELEGRAM_TOKEN in ~/.clawless/config.json or env and restart.');
      process.exit(1);
    }

    console.error('Failed to launch bot:', error);
    process.exit(1);
  });