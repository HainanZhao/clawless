import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { TelegramMessagingClient } from './messaging/telegramClient.js';
import { SlackMessagingClient } from './messaging/slackClient.js';
import { CronScheduler } from './scheduler/cronScheduler.js';
import { createScheduledJobHandler } from './scheduler/scheduledJobHandler.js';
import { processSingleTelegramMessage } from './messaging/liveMessageProcessor.js';
import { createMessageQueueProcessor } from './messaging/messageQueue.js';
import { registerTelegramHandlers } from './messaging/registerTelegramHandlers.js';
import { createCallbackServer } from './core/callbackServer.js';
import { runPromptWithTempAcp } from './acp/tempAcpRunner.js';
import { createAcpRuntime } from './acp/runtimeManager.js';
import { buildPermissionResponse, noOpAcpFileOperation } from './acp/clientHelpers.js';
import { getErrorMessage, logInfo } from './utils/error.js';
import { parseAllowlistFromEnv, parseWhitelistFromEnv } from './utils/telegramWhitelist.js';
import { normalizeOutgoingText } from './utils/commandText.js';
import {
  ensureBridgeHomeDirectory,
  resolveChatId,
  loadPersistedCallbackChatId,
  persistCallbackChatId,
} from './utils/callbackState.js';
import {
  ensureMemoryFile,
  readMemoryContext,
  buildPromptWithMemory as buildPromptWithMemoryTemplate,
} from './utils/memory.js';
import {
  ensureConversationHistoryFile,
  appendConversationEntry,
  loadConversationHistory,
  type ConversationHistoryConfig,
} from './utils/conversationHistory.js';
import {
  SemanticConversationMemory,
  type SemanticConversationMemoryConfig,
} from './utils/semanticConversationMemory.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const MESSAGING_PLATFORM = (process.env.MESSAGING_PLATFORM || 'telegram').trim().toLowerCase();
const SUPPORTED_PLATFORMS = new Set(['telegram', 'slack']);

if (!SUPPORTED_PLATFORMS.has(MESSAGING_PLATFORM)) {
  console.error(`Error: Unknown MESSAGING_PLATFORM: ${MESSAGING_PLATFORM}. Use 'telegram' or 'slack'.`);
  process.exit(1);
}

if (MESSAGING_PLATFORM === 'telegram') {
  if (!process.env.TELEGRAM_TOKEN) {
    console.error('Error: TELEGRAM_TOKEN environment variable is required for Telegram');
    process.exit(1);
  }

  if (
    process.env.TELEGRAM_TOKEN.includes('your_telegram_bot_token_here') ||
    !process.env.TELEGRAM_TOKEN.includes(':')
  ) {
    console.error('Error: TELEGRAM_TOKEN looks invalid. Set a real token from @BotFather in your config/env.');
    process.exit(1);
  }
}

if (MESSAGING_PLATFORM === 'slack') {
  if (!process.env.SLACK_BOT_TOKEN) {
    console.error('Error: SLACK_BOT_TOKEN environment variable is required for Slack');
    process.exit(1);
  }

  if (!process.env.SLACK_SIGNING_SECRET) {
    console.error('Error: SLACK_SIGNING_SECRET environment variable is required for Slack');
    process.exit(1);
  }
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

// Conversation history configuration
const CONVERSATION_HISTORY_ENABLED =
  String(process.env.CONVERSATION_HISTORY_ENABLED || 'true').toLowerCase() === 'true';
const CONVERSATION_HISTORY_FILE_PATH =
  process.env.CONVERSATION_HISTORY_FILE_PATH || path.join(AGENT_BRIDGE_HOME, 'conversation-history.jsonl');
const CONVERSATION_HISTORY_MAX_ENTRIES = parseInt(process.env.CONVERSATION_HISTORY_MAX_ENTRIES || '100', 10);
const CONVERSATION_HISTORY_MAX_CHARS_PER_ENTRY = parseInt(
  process.env.CONVERSATION_HISTORY_MAX_CHARS_PER_ENTRY || '2000',
  10,
);
const CONVERSATION_HISTORY_MAX_TOTAL_CHARS = parseInt(process.env.CONVERSATION_HISTORY_MAX_TOTAL_CHARS || '8000', 10);
const CONVERSATION_HISTORY_RECAP_TOP_K = parseInt(process.env.CONVERSATION_HISTORY_RECAP_TOP_K || '3', 10);
const CONVERSATION_SEMANTIC_RECALL_ENABLED =
  String(process.env.CONVERSATION_SEMANTIC_RECALL_ENABLED || 'true').toLowerCase() === 'true';
const CONVERSATION_SEMANTIC_MODEL_PATH =
  process.env.CONVERSATION_SEMANTIC_MODEL_PATH ||
  'hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf';
const CONVERSATION_SEMANTIC_STORE_PATH =
  process.env.CONVERSATION_SEMANTIC_STORE_PATH || path.join(AGENT_BRIDGE_HOME, 'conversation-semantic-memory.db');
const CONVERSATION_SEMANTIC_MAX_ENTRIES = parseInt(process.env.CONVERSATION_SEMANTIC_MAX_ENTRIES || '1000', 10);
const CONVERSATION_SEMANTIC_MAX_CHARS_PER_ENTRY = parseInt(
  process.env.CONVERSATION_SEMANTIC_MAX_CHARS_PER_ENTRY || '4000',
  10,
);
const CONVERSATION_SEMANTIC_TIMEOUT_MS = parseInt(process.env.CONVERSATION_SEMANTIC_TIMEOUT_MS || '15000', 10);

// Typing indicator refresh interval (platform typing state expires quickly)
const TYPING_INTERVAL_MS = parseInt(process.env.TYPING_INTERVAL_MS || '4000', 10);
const STREAM_UPDATE_INTERVAL_MS = parseInt(process.env.STREAM_UPDATE_INTERVAL_MS || '5000', 10);
const MESSAGE_GAP_THRESHOLD_MS = 15000; // Start a new message if gap between chunks > 5s

// Maximum response length to prevent memory issues
const MAX_RESPONSE_LENGTH = parseInt(process.env.MAX_RESPONSE_LENGTH || '4000', 10);

const TELEGRAM_WHITELIST: string[] = parseWhitelistFromEnv(process.env.TELEGRAM_WHITELIST || '');
const SLACK_WHITELIST: string[] = parseAllowlistFromEnv(process.env.SLACK_WHITELIST || '', 'SLACK_WHITELIST');
const TELEGRAM_WHITELIST_MAX_USERS = 10;

if (MESSAGING_PLATFORM === 'telegram') {
  if (TELEGRAM_WHITELIST.length === 0) {
    console.error(
      'Error: TELEGRAM_WHITELIST is required in Telegram mode and cannot be empty. Configure a JSON array of allowed usernames.',
    );
    process.exit(1);
  }

  if (TELEGRAM_WHITELIST.length > TELEGRAM_WHITELIST_MAX_USERS) {
    console.error(
      `Error: TELEGRAM_WHITELIST is too large (${TELEGRAM_WHITELIST.length}). Keep it to ${TELEGRAM_WHITELIST_MAX_USERS} users or fewer for safety.`,
    );
    process.exit(1);
  }
}

if (MESSAGING_PLATFORM === 'slack') {
  if (SLACK_WHITELIST.length === 0) {
    console.error(
      'Error: SLACK_WHITELIST is required in Slack mode and cannot be empty. Configure a JSON array of allowed Slack user IDs.',
    );
    process.exit(1);
  }

  if (SLACK_WHITELIST.length > TELEGRAM_WHITELIST_MAX_USERS) {
    console.error(
      `Error: SLACK_WHITELIST is too large (${SLACK_WHITELIST.length}). Keep it to ${TELEGRAM_WHITELIST_MAX_USERS} users or fewer for safety.`,
    );
    process.exit(1);
  }
}

const ACTIVE_USER_WHITELIST = MESSAGING_PLATFORM === 'telegram' ? TELEGRAM_WHITELIST : SLACK_WHITELIST;

type MessagingClient = TelegramMessagingClient | SlackMessagingClient;

let messagingClient: MessagingClient;

if (MESSAGING_PLATFORM === 'telegram') {
  messagingClient = new TelegramMessagingClient({
    token: process.env.TELEGRAM_TOKEN || '',
    typingIntervalMs: TYPING_INTERVAL_MS,
    maxMessageLength: MAX_RESPONSE_LENGTH,
  });
} else {
  messagingClient = new SlackMessagingClient({
    token: process.env.SLACK_BOT_TOKEN || '',
    signingSecret: process.env.SLACK_SIGNING_SECRET || '',
    appToken: process.env.SLACK_APP_TOKEN,
    typingIntervalMs: TYPING_INTERVAL_MS,
    maxMessageLength: MAX_RESPONSE_LENGTH,
  });
}

const enforceWhitelist = true;

let lastIncomingChatId: string | null = null;
const GEMINI_STDERR_TAIL_MAX = 4000;

// Conversation history configuration
const conversationHistoryConfig: ConversationHistoryConfig = {
  filePath: CONVERSATION_HISTORY_FILE_PATH,
  maxEntries: CONVERSATION_HISTORY_MAX_ENTRIES,
  maxCharsPerEntry: CONVERSATION_HISTORY_MAX_CHARS_PER_ENTRY,
  maxTotalChars: CONVERSATION_HISTORY_MAX_TOTAL_CHARS,
  logInfo,
};

const semanticConversationMemoryConfig: SemanticConversationMemoryConfig = {
  enabled: CONVERSATION_SEMANTIC_RECALL_ENABLED,
  storePath: CONVERSATION_SEMANTIC_STORE_PATH,
  modelPath: CONVERSATION_SEMANTIC_MODEL_PATH,
  maxEntries: CONVERSATION_SEMANTIC_MAX_ENTRIES,
  maxCharsPerEntry: CONVERSATION_SEMANTIC_MAX_CHARS_PER_ENTRY,
  timeoutMs: CONVERSATION_SEMANTIC_TIMEOUT_MS,
};

const semanticConversationMemory = new SemanticConversationMemory(semanticConversationMemoryConfig, logInfo);

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

logInfo('Scheduler persistence configured', {
  schedulesFilePath: SCHEDULES_FILE_PATH,
});

const { startCallbackServer, stopCallbackServer } = createCallbackServer({
  callbackHost: CALLBACK_HOST,
  callbackPort: CALLBACK_PORT,
  callbackAuthToken: CALLBACK_AUTH_TOKEN,
  callbackMaxBodyBytes: CALLBACK_MAX_BODY_BYTES,
  cronScheduler,
  messagingClient,
  messagingPlatform: MESSAGING_PLATFORM,
  getLastIncomingChatId: () => lastIncomingChatId,
  semanticConversationMemory,
  conversationHistoryMaxTotalChars: CONVERSATION_HISTORY_MAX_TOTAL_CHARS,
  conversationHistoryRecapTopK: CONVERSATION_HISTORY_RECAP_TOP_K,
  logInfo,
});

async function buildPromptWithMemory(userPrompt: string): Promise<string> {
  const memoryContext = readMemoryContext(MEMORY_FILE_PATH, MEMORY_MAX_CHARS, logInfo);

  return buildPromptWithMemoryTemplate({
    userPrompt,
    memoryFilePath: MEMORY_FILE_PATH,
    callbackHost: CALLBACK_HOST,
    callbackPort: CALLBACK_PORT,
    callbackChatStateFilePath: CALLBACK_CHAT_STATE_FILE_PATH,
    callbackAuthToken: CALLBACK_AUTH_TOKEN,
    memoryContext,
    messagingPlatform: MESSAGING_PLATFORM,
  });
}

const acpRuntime = createAcpRuntime({
  geminiCommand: GEMINI_COMMAND,
  includeDirectories: [AGENT_BRIDGE_HOME, os.homedir()],
  geminiApprovalMode: GEMINI_APPROVAL_MODE,
  geminiModel: GEMINI_MODEL,
  acpPermissionStrategy: ACP_PERMISSION_STRATEGY,
  acpStreamStdout: ACP_STREAM_STDOUT,
  acpDebugStream: ACP_DEBUG_STREAM,
  acpTimeoutMs: GEMINI_TIMEOUT_MS,
  acpNoOutputTimeoutMs: GEMINI_NO_OUTPUT_TIMEOUT_MS,
  acpPrewarmRetryMs: ACP_PREWARM_RETRY_MS,
  geminiKillGraceMs: GEMINI_KILL_GRACE_MS,
  stderrTailMaxChars: GEMINI_STDERR_TAIL_MAX,
  buildPromptWithMemory,
  ensureMemoryFile: () => ensureMemoryFile(MEMORY_FILE_PATH, logInfo),
  buildPermissionResponse,
  noOpAcpFileOperation,
  getErrorMessage,
  logInfo,
});

function setupGracefulShutdown() {
  const shutdownSignals = ['SIGINT', 'SIGTERM'];

  for (const signal of shutdownSignals) {
    process.once(signal, () => {
      console.log(`Received ${signal}, stopping bot...`);
      cronScheduler.shutdown();
      stopCallbackServer();
      messagingClient.stop(signal);
      void acpRuntime.shutdownAcpRuntime(`signal:${signal}`);
    });
  }
}

async function runScheduledPromptWithTempAcp(promptForGemini: string, scheduleId: string): Promise<string> {
  return runPromptWithTempAcp({
    scheduleId,
    promptForGemini,
    command: GEMINI_COMMAND,
    args: acpRuntime.buildGeminiAcpArgs(),
    cwd: process.cwd(),
    timeoutMs: GEMINI_TIMEOUT_MS,
    noOutputTimeoutMs: GEMINI_NO_OUTPUT_TIMEOUT_MS,
    permissionStrategy: ACP_PERMISSION_STRATEGY,
    stderrTailMaxChars: GEMINI_STDERR_TAIL_MAX,
    logInfo,
  });
}
const runAcpPrompt = acpRuntime.runAcpPrompt;
const hasActiveAcpPrompt = acpRuntime.hasActiveAcpPrompt;
const cancelActiveAcpPrompt = acpRuntime.cancelActiveAcpPrompt;

const { enqueueMessage, getQueueLength } = createMessageQueueProcessor({
  processSingleMessage: (messageContext, messageRequestId) => {
    return processSingleTelegramMessage({
      messageContext,
      messageRequestId,
      maxResponseLength: MAX_RESPONSE_LENGTH,
      streamUpdateIntervalMs: STREAM_UPDATE_INTERVAL_MS,
      messageGapThresholdMs: MESSAGE_GAP_THRESHOLD_MS,
      acpDebugStream: ACP_DEBUG_STREAM,
      runAcpPrompt,
      logInfo,
      getErrorMessage,
      onConversationComplete: CONVERSATION_HISTORY_ENABLED
        ? (userMessage, botResponse, chatId) => {
            const appendedEntry = appendConversationEntry(conversationHistoryConfig, {
              chatId,
              userMessage,
              botResponse,
              platform: MESSAGING_PLATFORM,
            });

            if (appendedEntry && semanticConversationMemory.isEnabled) {
              void semanticConversationMemory.indexEntry(appendedEntry);
            }
          }
        : undefined,
    });
  },
  logInfo,
  getErrorMessage,
});

registerTelegramHandlers({
  messagingClient,
  telegramWhitelist: ACTIVE_USER_WHITELIST,
  enforceWhitelist,
  hasActiveAcpPrompt,
  cancelActiveAcpPrompt,
  enqueueMessage,
  onAbortRequested: acpRuntime.requestManualAbort,
  onChatBound: (chatId) => {
    lastIncomingChatId = chatId;
    persistCallbackChatId(
      CALLBACK_CHAT_STATE_FILE_PATH,
      chatId,
      () => ensureBridgeHomeDirectory(AGENT_BRIDGE_HOME),
      logInfo,
    );
  },
});

// Graceful shutdown
setupGracefulShutdown();

// Launch the bot
logInfo('Starting Clawless server...', {
  messagingPlatform: MESSAGING_PLATFORM,
});
validateGeminiCommandOrExit();
ensureBridgeHomeDirectory(AGENT_BRIDGE_HOME);
ensureMemoryFile(MEMORY_FILE_PATH, logInfo);
if (CONVERSATION_HISTORY_ENABLED) {
  ensureConversationHistoryFile(CONVERSATION_HISTORY_FILE_PATH, logInfo);

  if (semanticConversationMemory.isEnabled) {
    semanticConversationMemory.ensureStoreFile();
    const historicalEntries = loadConversationHistory(conversationHistoryConfig);
    void semanticConversationMemory.warmFromHistory(historicalEntries);
  }
}
lastIncomingChatId = loadPersistedCallbackChatId(CALLBACK_CHAT_STATE_FILE_PATH, logInfo);
if (lastIncomingChatId) {
  logInfo('Loaded callback chat binding', { chatId: lastIncomingChatId });
}
startCallbackServer();
acpRuntime.scheduleAcpPrewarm('startup');
messagingClient
  .launch()
  .then(async () => {
    logInfo('Bot launched successfully', {
      messagingPlatform: MESSAGING_PLATFORM,
      typingIntervalMs: TYPING_INTERVAL_MS,
      streamUpdateIntervalMs: STREAM_UPDATE_INTERVAL_MS,
      geminiTimeoutMs: GEMINI_TIMEOUT_MS,
      geminiNoOutputTimeoutMs: GEMINI_NO_OUTPUT_TIMEOUT_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      acpPrewarmRetryMs: ACP_PREWARM_RETRY_MS,
      memoryFilePath: MEMORY_FILE_PATH,
      conversationHistoryEnabled: CONVERSATION_HISTORY_ENABLED,
      conversationHistoryFilePath: CONVERSATION_HISTORY_ENABLED ? CONVERSATION_HISTORY_FILE_PATH : 'disabled',
      conversationHistoryRecapTopK: CONVERSATION_HISTORY_RECAP_TOP_K,
      conversationSemanticRecallEnabled: CONVERSATION_SEMANTIC_RECALL_ENABLED,
      conversationSemanticModelPath: CONVERSATION_SEMANTIC_RECALL_ENABLED ? CONVERSATION_SEMANTIC_MODEL_PATH : 'n/a',
      conversationSemanticStorePath: CONVERSATION_SEMANTIC_RECALL_ENABLED ? CONVERSATION_SEMANTIC_STORE_PATH : 'n/a',
      callbackHost: CALLBACK_HOST,
      callbackPort: CALLBACK_PORT,
      mcpSkillsSource: 'local Gemini CLI defaults (no MCP override)',
      acpMode: `${GEMINI_COMMAND} --experimental-acp`,
      authorizedUsers: `${ACTIVE_USER_WHITELIST.length} user(s) authorized`,
    });

    if (MESSAGING_PLATFORM === 'telegram') {
      console.log(`✅ Telegram authorization enabled. Authorized usernames: ${TELEGRAM_WHITELIST.join(', ')}`);
    }

    if (MESSAGING_PLATFORM === 'slack') {
      console.log(
        `✅ Slack authorization enabled. Authorized principals (IDs or emails): ${SLACK_WHITELIST.join(', ')}`,
      );
    }

    acpRuntime.scheduleAcpPrewarm('post-launch');

    if (HEARTBEAT_INTERVAL_MS > 0) {
      setInterval(() => {
        const runtimeState = acpRuntime.getRuntimeState();
        logInfo('Heartbeat', {
          queueLength: getQueueLength(),
          acpSessionReady: runtimeState.acpSessionReady,
          geminiProcessRunning: runtimeState.geminiProcessRunning,
        });
      }, HEARTBEAT_INTERVAL_MS);
    }
  })
  .catch((error: any) => {
    if (MESSAGING_PLATFORM === 'telegram' && error?.response?.error_code === 404 && error?.on?.method === 'getMe') {
      console.error('Failed to launch bot: Telegram token is invalid (getMe returned 404 Not Found).');
      console.error('Update TELEGRAM_TOKEN in ~/.clawless/config.json or env and restart.');
      process.exit(1);
    }

    console.error('Failed to launch bot:', error);
    process.exit(1);
  });
