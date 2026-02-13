import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { TelegramMessagingClient } from './messaging/telegramClient.js';
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
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || '900000', 10);
const GEMINI_NO_OUTPUT_TIMEOUT_MS = parseInt(process.env.GEMINI_NO_OUTPUT_TIMEOUT_MS || '60000', 10);
const GEMINI_APPROVAL_MODE = process.env.GEMINI_APPROVAL_MODE || 'yolo';
const GEMINI_MODEL = process.env.GEMINI_MODEL || '';
const ACP_PERMISSION_STRATEGY = process.env.ACP_PERMISSION_STRATEGY || 'allow_once';
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '60000', 10);
const ACP_PREWARM_RETRY_MS = parseInt(process.env.ACP_PREWARM_RETRY_MS || '30000', 10);
const AGENT_BRIDGE_HOME = process.env.AGENT_BRIDGE_HOME || path.join(os.homedir(), '.gemini-bridge');
const MEMORY_FILE_PATH = process.env.MEMORY_FILE_PATH || path.join(AGENT_BRIDGE_HOME, 'MEMORY.md');
const CALLBACK_CHAT_STATE_FILE_PATH = path.join(AGENT_BRIDGE_HOME, 'callback-chat-state.json');
const MEMORY_MAX_CHARS = parseInt(process.env.MEMORY_MAX_CHARS || '12000', 10);
const CALLBACK_HOST = process.env.CALLBACK_HOST || '127.0.0.1';
const CALLBACK_PORT = parseInt(process.env.CALLBACK_PORT || '8787', 10);
const CALLBACK_AUTH_TOKEN = process.env.CALLBACK_AUTH_TOKEN || '';
const CALLBACK_MAX_BODY_BYTES = parseInt(process.env.CALLBACK_MAX_BODY_BYTES || '65536', 10);

// Typing indicator refresh interval (Telegram typing state expires quickly)
const TYPING_INTERVAL_MS = parseInt(process.env.TYPING_INTERVAL_MS || '4000', 10);

// Maximum response length to prevent memory issues (Telegram has 4096 char limit anyway)
const MAX_RESPONSE_LENGTH = parseInt(process.env.MAX_RESPONSE_LENGTH || '4000', 10);

const messagingClient = new TelegramMessagingClient({
  token: process.env.TELEGRAM_TOKEN,
  typingIntervalMs: TYPING_INTERVAL_MS,
});

let geminiProcess: any = null;
let acpConnection: any = null;
let acpSessionId: any = null;
let acpInitPromise: Promise<void> | null = null;
let activePromptCollector: any = null;
let messageSequence = 0;
let acpPrewarmRetryTimer: NodeJS.Timeout | null = null;
let geminiStderrTail = '';
let callbackServer: http.Server | null = null;
let lastIncomingChatId: string | null = null;
const GEMINI_STDERR_TAIL_MAX = 4000;

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
      error: error?.message || String(error),
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
      error: error?.message || String(error),
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

function normalizeOutgoingText(text: unknown) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= MAX_RESPONSE_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_RESPONSE_LENGTH)}\n\n[Response truncated due to length]`;
}

async function handleCallbackRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const hostHeader = req.headers.host || `${CALLBACK_HOST}:${CALLBACK_PORT}`;
  const requestUrl = new URL(req.url || '/', `http://${hostHeader}`);

  if (requestUrl.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

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
    sendJson(res, 400, { ok: false, error: error?.message || 'Invalid JSON body' });
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
    sendJson(res, 500, { ok: false, error: error?.message || 'Failed to send Telegram message' });
  }
}

function startCallbackServer() {
  if (callbackServer) {
    return;
  }

  callbackServer = http.createServer((req, res) => {
    handleCallbackRequest(req, res).catch((error: any) => {
      sendJson(res, 500, { ok: false, error: error?.message || 'Internal callback server error' });
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

function setupGracefulShutdown() {
  const shutdownSignals = ['SIGINT', 'SIGTERM'];

  for (const signal of shutdownSignals) {
    process.once(signal, () => {
      console.log(`Received ${signal}, stopping bot...`);
      stopCallbackServer();
      messagingClient.stop(signal);
    });
  }
}

function ensureMemoryFile() {
  ensureBridgeHomeDirectory();
  fs.mkdirSync(path.dirname(MEMORY_FILE_PATH), { recursive: true });

  if (!fs.existsSync(MEMORY_FILE_PATH)) {
    const template = [
      '# Gemini Bridge Memory',
      '',
      'This file stores durable memory notes for Gemini Bridge.',
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
      error: error?.message || String(error),
    });
    return '';
  }
}

function buildPromptWithMemory(userPrompt: string) {
  const memoryContext = readMemoryContext() || '(No saved memory yet)';
  const callbackEndpoint = `http://${CALLBACK_HOST}:${CALLBACK_PORT}/callback/telegram`;

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
    CALLBACK_AUTH_TOKEN
      ? '- Callback auth is enabled: include `x-callback-token` (or bearer token) when creating callback requests.'
      : '- Callback auth is disabled unless CALLBACK_AUTH_TOKEN is configured.',
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
    const { options } = params;
    if (!Array.isArray(options) || options.length === 0) {
      return { outcome: { outcome: 'cancelled' } };
    }

    if (ACP_PERMISSION_STRATEGY === 'cancelled') {
      return { outcome: { outcome: 'cancelled' } };
    }

    const preferred = options.find((option: any) => option.kind === ACP_PERMISSION_STRATEGY);
    const selectedOption = preferred || options[0];

    return {
      outcome: {
        outcome: 'selected',
        optionId: selectedOption.optionId,
      },
    };
  }

  async sessionUpdate(params: any) {
    if (!activePromptCollector || params.sessionId !== acpSessionId) {
      return;
    }

    activePromptCollector.onActivity();

    if (params.update?.sessionUpdate === 'agent_message_chunk' && params.update?.content?.type === 'text') {
      activePromptCollector.append(params.update.content.text);
    }
  }

  async readTextFile(_params: any) {
    return {};
  }

  async writeTextFile(_params: any) {
    return {};
  }
}

const acpClient = new TelegramAcpClient();

function resetAcpRuntime() {
  logInfo('Resetting ACP runtime state');
  activePromptCollector = null;
  acpConnection = null;
  acpSessionId = null;
  acpInitPromise = null;

  if (geminiProcess && !geminiProcess.killed) {
    geminiProcess.kill('SIGTERM');
  }
  geminiProcess = null;
  geminiStderrTail = '';

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
      logInfo('Gemini ACP prewarm failed', { error: error?.message || String(error) });
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
      const baseMessage = error?.message || String(error);
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
      await processSingleMessage(item.messageContext);
      logInfo('Message processed', { requestId: item.requestId });
      item.resolve();
    } catch (error: any) {
      logInfo('Message processing failed', { requestId: item.requestId, error: error?.message || String(error) });
      item.reject(error);
    }
  }
  isQueueProcessing = false;
}

/**
 * Streams text output from Gemini CLI for a single prompt.
 */
async function runAcpPrompt(promptText: string) {
  await ensureAcpSession();
  logInfo('Starting ACP prompt', { sessionId: acpSessionId, promptLength: promptText.length });
  const promptForGemini = buildPromptWithMemory(promptText);

  return new Promise<string>((resolve, reject) => {
    let fullResponse = '';
    let isTruncated = false;
    let isSettled = false;
    let noOutputTimeout: NodeJS.Timeout | null = null;

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
      clearTimers();
      activePromptCollector = null;
      logInfo('ACP prompt failed', { sessionId: acpSessionId, error: error?.message || String(error) });
      reject(error);
    };

    const resolveOnce = (value: string) => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      clearTimers();
      activePromptCollector = null;
      logInfo('ACP prompt completed', { sessionId: acpSessionId, responseLength: value.length });
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
        if (isTruncated) {
          return;
        }

        fullResponse += textChunk;
        if (fullResponse.length > MAX_RESPONSE_LENGTH) {
          fullResponse = fullResponse.substring(0, MAX_RESPONSE_LENGTH) + '\n\n[Response truncated due to length]';
          isTruncated = true;
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
        if (result?.stopReason === 'cancelled' && !fullResponse) {
          failOnce(new Error('Gemini ACP prompt was cancelled'));
          return;
        }
        resolveOnce(fullResponse || 'No response received.');
      })
      .catch((error: any) => {
        failOnce(new Error(error?.message || 'Gemini ACP prompt failed'));
      });
  });
}

async function processSingleMessage(messageContext: any) {
  const stopTypingIndicator = messageContext.startTyping();
  try {
    const fullResponse = await runAcpPrompt(messageContext.text);
    await messageContext.sendText(fullResponse || 'No response received.');
  } finally {
    stopTypingIndicator();
  }
}

/**
 * Handles incoming text messages from Telegram
 */
messagingClient.onTextMessage((messageContext) => {
  if (messageContext.chatId !== undefined && messageContext.chatId !== null) {
    lastIncomingChatId = String(messageContext.chatId);
    persistCallbackChatId(lastIncomingChatId);
  }

  enqueueMessage(messageContext)
    .catch(async (error: any) => {
      console.error('Error processing message:', error);
      await messageContext.sendText(`❌ Error: ${error.message}`);
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
    });

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
      console.error('Update TELEGRAM_TOKEN in ~/.gemini-bridge/config.json or env and restart.');
      process.exit(1);
    }

    console.error('Failed to launch bot:', error);
    process.exit(1);
  });