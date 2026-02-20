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
import { runPromptWithCli } from './acp/tempAcpRunner.js';
import { createAcpRuntime } from './acp/runtimeManager.js';
import { buildPermissionResponse, noOpAcpFileOperation } from './acp/clientHelpers.js';
import { createCliAgent, validateAgentType, SUPPORTED_AGENTS, type AgentType } from './core/agents/index.js';
import { getErrorMessage, logInfo } from './utils/error.js';
import { parseAllowlistFromEnv, parseWhitelistFromEnv } from './utils/telegramWhitelist.js';
import { normalizeOutgoingText } from './utils/commandText.js';
import {
  ensureClawlessHomeDirectory,
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
import { getConfig } from './utils/config.js';

// Load environment variables
dotenv.config();

const config = getConfig();

const MESSAGING_PLATFORM = config.MESSAGING_PLATFORM;

// CLI Agent configuration
const CLI_AGENT = config.CLI_AGENT;

let agentCommand: string;
switch (CLI_AGENT) {
  case 'opencode':
    agentCommand = 'opencode';
    break;
  case 'claude':
    agentCommand = 'claude-agent-acp';
    break;
  default:
    agentCommand = 'gemini';
    break;
}
const CLI_AGENT_TIMEOUT_MS = config.CLI_AGENT_TIMEOUT_MS;
const CLI_AGENT_NO_OUTPUT_TIMEOUT_MS = config.CLI_AGENT_NO_OUTPUT_TIMEOUT_MS;
const CLI_AGENT_APPROVAL_MODE = config.CLI_AGENT_APPROVAL_MODE;
const CLI_AGENT_MODEL = config.CLI_AGENT_MODEL;
const CLI_AGENT_KILL_GRACE_MS = config.CLI_AGENT_KILL_GRACE_MS;
const ACP_PERMISSION_STRATEGY = config.ACP_PERMISSION_STRATEGY;
const ACP_STREAM_STDOUT = config.ACP_STREAM_STDOUT;
const ACP_DEBUG_STREAM = config.ACP_DEBUG_STREAM;
const HEARTBEAT_INTERVAL_MS = config.HEARTBEAT_INTERVAL_MS;
const ACP_PREWARM_RETRY_MS = config.ACP_PREWARM_RETRY_MS;
const CLAWLESS_HOME = config.CLAWLESS_HOME;
const MEMORY_FILE_PATH = config.MEMORY_FILE_PATH;
const SCHEDULES_FILE_PATH = config.SCHEDULES_FILE_PATH;
const CALLBACK_CHAT_STATE_FILE_PATH = path.join(CLAWLESS_HOME, 'callback-chat-state.json');
const MEMORY_MAX_CHARS = config.MEMORY_MAX_CHARS;
const CALLBACK_HOST = config.CALLBACK_HOST;
const CALLBACK_PORT = config.CALLBACK_PORT;
const CALLBACK_AUTH_TOKEN = config.CALLBACK_AUTH_TOKEN;
const CALLBACK_MAX_BODY_BYTES = config.CALLBACK_MAX_BODY_BYTES;

// Conversation history configuration
const CONVERSATION_HISTORY_ENABLED = config.CONVERSATION_HISTORY_ENABLED;
const CONVERSATION_HISTORY_FILE_PATH = config.CONVERSATION_HISTORY_FILE_PATH;
const CONVERSATION_HISTORY_MAX_ENTRIES = config.CONVERSATION_HISTORY_MAX_ENTRIES;
const CONVERSATION_HISTORY_MAX_CHARS_PER_ENTRY = config.CONVERSATION_HISTORY_MAX_CHARS_PER_ENTRY;
const CONVERSATION_HISTORY_MAX_TOTAL_CHARS = config.CONVERSATION_HISTORY_MAX_TOTAL_CHARS;
const CONVERSATION_HISTORY_RECAP_TOP_K = config.CONVERSATION_HISTORY_RECAP_TOP_K;
const CONVERSATION_SEMANTIC_RECALL_ENABLED = config.CONVERSATION_SEMANTIC_RECALL_ENABLED;
const CONVERSATION_SEMANTIC_STORE_PATH = config.CONVERSATION_SEMANTIC_STORE_PATH;
const CONVERSATION_SEMANTIC_MAX_ENTRIES = config.CONVERSATION_SEMANTIC_MAX_ENTRIES;
const CONVERSATION_SEMANTIC_MAX_CHARS_PER_ENTRY = config.CONVERSATION_SEMANTIC_MAX_CHARS_PER_ENTRY;

// Typing indicator refresh interval (platform typing state expires quickly)
const TYPING_INTERVAL_MS = config.TYPING_INTERVAL_MS;
const STREAM_UPDATE_INTERVAL_MS = config.STREAM_UPDATE_INTERVAL_MS;
const MESSAGE_GAP_THRESHOLD_MS = 15000; // Start a new message if gap between chunks > 5s

// Maximum response length to prevent memory issues
const MAX_RESPONSE_LENGTH = config.MAX_RESPONSE_LENGTH;

const TELEGRAM_WHITELIST: string[] = parseWhitelistFromEnv(config.TELEGRAM_WHITELIST);
const SLACK_WHITELIST: string[] = parseAllowlistFromEnv(config.SLACK_WHITELIST, 'SLACK_WHITELIST');
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
    token: config.TELEGRAM_TOKEN || '',
    typingIntervalMs: TYPING_INTERVAL_MS,
    maxMessageLength: MAX_RESPONSE_LENGTH,
  });
} else {
  messagingClient = new SlackMessagingClient({
    token: config.SLACK_BOT_TOKEN || '',
    signingSecret: config.SLACK_SIGNING_SECRET || '',
    appToken: config.SLACK_APP_TOKEN,
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
  maxEntries: CONVERSATION_SEMANTIC_MAX_ENTRIES,
  maxCharsPerEntry: CONVERSATION_SEMANTIC_MAX_CHARS_PER_ENTRY,
};

const semanticConversationMemory = new SemanticConversationMemory(semanticConversationMemoryConfig, logInfo);

// Initialize CLI Agent
let cliAgentType: AgentType;
try {
  cliAgentType = validateAgentType(CLI_AGENT);
} catch (error: any) {
  console.error(`Error: ${error.message}`);
  console.error(`Available agents: ${SUPPORTED_AGENTS.join(', ')}`);
  process.exit(1);
}

const cliAgent = createCliAgent(cliAgentType, {
  command: agentCommand,
  approvalMode: CLI_AGENT_APPROVAL_MODE,
  model: CLI_AGENT_MODEL,
  includeDirectories: [CLAWLESS_HOME, os.homedir()],
  killGraceMs: CLI_AGENT_KILL_GRACE_MS,
  acpMcpServersJson: config.ACP_MCP_SERVERS_JSON,
});

function validateCliAgentOrExit() {
  const validation = cliAgent.validate();
  if (!validation.valid) {
    console.error(`Error: ${validation.error}`);
    process.exit(1);
  }
}

const handleScheduledJob = createScheduledJobHandler({
  logInfo,
  buildPromptWithMemory: buildScheduledJobPrompt,
  runScheduledPromptWithTempAcp,
  resolveTargetChatId: () => resolveChatId(lastIncomingChatId),
  sendTextToChat: (chatId, text) => messagingClient.sendTextToChat(chatId, text),
  normalizeOutgoingText,
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
  appendContextToAgent: (text) => acpRuntime.appendContext(text),
});

const cronScheduler = new CronScheduler(handleScheduledJob, {
  persistenceFilePath: SCHEDULES_FILE_PATH,
  timezone: config.TZ,
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

async function buildScheduledJobPrompt(userPrompt: string): Promise<string> {
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
    includeSchedulerApi: false,
  });
}

const acpRuntime = createAcpRuntime({
  cliAgent,
  acpPermissionStrategy: ACP_PERMISSION_STRATEGY,
  acpStreamStdout: ACP_STREAM_STDOUT,
  acpDebugStream: ACP_DEBUG_STREAM,
  acpTimeoutMs: CLI_AGENT_TIMEOUT_MS,
  acpNoOutputTimeoutMs: CLI_AGENT_NO_OUTPUT_TIMEOUT_MS,
  acpPrewarmRetryMs: ACP_PREWARM_RETRY_MS,
  acpPrewarmMaxRetries: config.ACP_PREWARM_MAX_RETRIES,
  acpMcpServersJson: config.ACP_MCP_SERVERS_JSON,
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
      logInfo(`Received ${signal}, stopping bot...`);
      cronScheduler.shutdown();
      stopCallbackServer();
      messagingClient.stop(signal);
      void acpRuntime.shutdownAcpRuntime(`signal:${signal}`);
    });
  }
}

async function runScheduledPromptWithTempAcp(promptForAgent: string, scheduleId: string): Promise<string> {
  return runPromptWithCli({
    scheduleId,
    promptForAgent,
    cliAgent,
    cwd: process.cwd(),
    timeoutMs: CLI_AGENT_TIMEOUT_MS,
    noOutputTimeoutMs: CLI_AGENT_NO_OUTPUT_TIMEOUT_MS,
    permissionStrategy: ACP_PERMISSION_STRATEGY,
    stderrTailMaxChars: GEMINI_STDERR_TAIL_MAX,
    logInfo,
    acpMcpServersJson: config.ACP_MCP_SERVERS_JSON,
    acpDebugStream: ACP_DEBUG_STREAM,
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
      scheduleAsyncJob: async (message, chatId, jobRef) => {
        logInfo('scheduleAsyncJob called', { message, chatId, jobRef });
        const scheduledId = await cronScheduler.executeOneTimeJobImmediately(
          message,
          'Async User Task',
          { chatId },
          jobRef,
        );
        logInfo('scheduleAsyncJob completed', { message, chatId, jobId: scheduledId });
        return scheduledId;
      },
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
      () => ensureClawlessHomeDirectory(CLAWLESS_HOME),
      logInfo,
    );
  },
});

// Graceful shutdown
setupGracefulShutdown();

// Launch the bot
logInfo('Starting Clawless server...', {
  messagingPlatform: MESSAGING_PLATFORM,
  cliAgent: cliAgent.getDisplayName(),
});
validateCliAgentOrExit();
ensureClawlessHomeDirectory(CLAWLESS_HOME);
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
      cliAgent: cliAgent.getDisplayName(),
      typingIntervalMs: TYPING_INTERVAL_MS,
      streamUpdateIntervalMs: STREAM_UPDATE_INTERVAL_MS,
      agentTimeoutMs: CLI_AGENT_TIMEOUT_MS,
      agentNoOutputTimeoutMs: CLI_AGENT_NO_OUTPUT_TIMEOUT_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      acpPrewarmRetryMs: ACP_PREWARM_RETRY_MS,
      memoryFilePath: MEMORY_FILE_PATH,
      conversationHistoryEnabled: CONVERSATION_HISTORY_ENABLED,
      conversationHistoryFilePath: CONVERSATION_HISTORY_ENABLED ? CONVERSATION_HISTORY_FILE_PATH : 'disabled',
      conversationHistoryRecapTopK: CONVERSATION_HISTORY_RECAP_TOP_K,
      conversationSemanticRecallEnabled: CONVERSATION_SEMANTIC_RECALL_ENABLED,
      conversationSemanticEngine: CONVERSATION_SEMANTIC_RECALL_ENABLED ? 'sqlite-fts5' : 'disabled',
      conversationSemanticStorePath: CONVERSATION_SEMANTIC_RECALL_ENABLED ? CONVERSATION_SEMANTIC_STORE_PATH : 'n/a',
      callbackHost: CALLBACK_HOST,
      callbackPort: CALLBACK_PORT,
      mcpSkillsSource: `local ${cliAgent.getDisplayName()} defaults (no MCP override)`,
      acpMode: `${cliAgent.getCommand()} ${acpRuntime.buildAgentAcpArgs().join(' ')}`,
      authorizedUsers: `${ACTIVE_USER_WHITELIST.length} user(s) authorized`,
    });

    if (MESSAGING_PLATFORM === 'telegram') {
      logInfo(`✅ Telegram authorization enabled. Authorized usernames: ${TELEGRAM_WHITELIST.join(', ')}`);
    }

    if (MESSAGING_PLATFORM === 'slack') {
      logInfo(`✅ Slack authorization enabled. Authorized principals (user IDs): ${SLACK_WHITELIST.join(', ')}`);
    }

    acpRuntime.scheduleAcpPrewarm('post-launch');

    if (HEARTBEAT_INTERVAL_MS > 0) {
      setInterval(() => {
        const runtimeState = acpRuntime.getRuntimeState();
        logInfo('Heartbeat', {
          queueLength: getQueueLength(),
          acpSessionReady: runtimeState.acpSessionReady,
          agentProcessRunning: runtimeState.agentProcessRunning,
        });
      }, HEARTBEAT_INTERVAL_MS);
    }
  })
  .catch((error: any) => {
    if (MESSAGING_PLATFORM === 'telegram' && error?.response?.error_code === 404 && error?.on?.method === 'getMe') {
      logInfo('Failed to launch bot: Telegram token is invalid (getMe returned 404 Not Found).');
      logInfo('Update TELEGRAM_TOKEN in ~/.clawless/config.json or env and restart.');
      process.exit(1);
    }

    logInfo('Failed to launch bot:', error);
    process.exit(1);
  });
