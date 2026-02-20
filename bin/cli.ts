#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import { runConfigTui } from './configTui.js';
import { getConfig, resetConfig } from '../utils/config.js';

const ENV_KEY_MAP: Record<string, string> = {
  messagingPlatform: 'MESSAGING_PLATFORM',
  telegramToken: 'TELEGRAM_TOKEN',
  telegramWhitelist: 'TELEGRAM_WHITELIST',
  slackBotToken: 'SLACK_BOT_TOKEN',
  slackSigningSecret: 'SLACK_SIGNING_SECRET',
  slackAppToken: 'SLACK_APP_TOKEN',
  slackWhitelist: 'SLACK_WHITELIST',
  timezone: 'TZ',
  typingIntervalMs: 'TYPING_INTERVAL_MS',
  streamUpdateIntervalMs: 'STREAM_UPDATE_INTERVAL_MS',
  cliAgent: 'CLI_AGENT',
  cliAgentApprovalMode: 'CLI_AGENT_APPROVAL_MODE',
  cliAgentModel: 'CLI_AGENT_MODEL',
  cliAgentTimeoutMs: 'CLI_AGENT_TIMEOUT_MS',
  cliAgentNoOutputTimeoutMs: 'CLI_AGENT_NO_OUTPUT_TIMEOUT_MS',
  cliAgentKillGraceMs: 'CLI_AGENT_KILL_GRACE_MS',
  acpPermissionStrategy: 'ACP_PERMISSION_STRATEGY',
  acpPrewarmRetryMs: 'ACP_PREWARM_RETRY_MS',
  acpPrewarmMaxRetries: 'ACP_PREWARM_MAX_RETRIES',
  acpMcpServersJson: 'ACP_MCP_SERVERS_JSON',
  maxResponseLength: 'MAX_RESPONSE_LENGTH',
  acpStreamStdout: 'ACP_STREAM_STDOUT',
  acpDebugStream: 'ACP_DEBUG_STREAM',
  heartbeatIntervalMs: 'HEARTBEAT_INTERVAL_MS',
  callbackHost: 'CALLBACK_HOST',
  callbackPort: 'CALLBACK_PORT',
  callbackAuthToken: 'CALLBACK_AUTH_TOKEN',
  callbackMaxBodyBytes: 'CALLBACK_MAX_BODY_BYTES',
  clawlessHome: 'CLAWLESS_HOME',
  memoryFilePath: 'MEMORY_FILE_PATH',
  memoryMaxChars: 'MEMORY_MAX_CHARS',
  conversationHistoryEnabled: 'CONVERSATION_HISTORY_ENABLED',
  conversationHistoryFilePath: 'CONVERSATION_HISTORY_FILE_PATH',
  conversationHistoryMaxEntries: 'CONVERSATION_HISTORY_MAX_ENTRIES',
  conversationHistoryMaxCharsPerEntry: 'CONVERSATION_HISTORY_MAX_CHARS_PER_ENTRY',
  conversationHistoryMaxTotalChars: 'CONVERSATION_HISTORY_MAX_TOTAL_CHARS',
  conversationHistoryRecapTopK: 'CONVERSATION_HISTORY_RECAP_TOP_K',
  conversationSemanticRecallEnabled: 'CONVERSATION_SEMANTIC_RECALL_ENABLED',
  conversationSemanticStorePath: 'CONVERSATION_SEMANTIC_STORE_PATH',
  conversationSemanticMaxEntries: 'CONVERSATION_SEMANTIC_MAX_ENTRIES',
  conversationSemanticMaxCharsPerEntry: 'CONVERSATION_SEMANTIC_MAX_CHARS_PER_ENTRY',
  schedulesFilePath: 'SCHEDULES_FILE_PATH',
};

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.clawless', 'config.json');
const DEFAULT_CLAWLESS_HOME = path.join(os.homedir(), '.clawless');
const DEFAULT_MEMORY_FILE_PATH = path.join(DEFAULT_CLAWLESS_HOME, 'MEMORY.md');
const DEFAULT_CONFIG_TEMPLATE = {
  messagingPlatform: 'telegram',
  telegramToken: 'your_telegram_bot_token_here',
  telegramWhitelist: [],
  slackBotToken: '',
  slackSigningSecret: '',
  slackAppToken: '',
  slackWhitelist: [],
  timezone: 'UTC',
  typingIntervalMs: 4000,
  streamUpdateIntervalMs: 5000,
  cliAgent: 'gemini',
  cliAgentApprovalMode: 'yolo',
  cliAgentModel: '',
  cliAgentTimeoutMs: 1200000,
  cliAgentNoOutputTimeoutMs: 300000,
  cliAgentKillGraceMs: 10000,
  acpPermissionStrategy: 'allow_once',
  acpPrewarmRetryMs: 30000,
  acpPrewarmMaxRetries: 10,
  acpMcpServersJson: '',
  maxResponseLength: 4000,
  acpStreamStdout: false,
  acpDebugStream: false,
  heartbeatIntervalMs: 300000,
  callbackHost: 'localhost',
  callbackPort: 8788,
  callbackAuthToken: '',
  callbackMaxBodyBytes: 65536,
  clawlessHome: '~/.clawless',
  memoryFilePath: '~/.clawless/MEMORY.md',
  memoryMaxChars: 12000,
  conversationHistoryEnabled: true,
  conversationHistoryFilePath: '~/.clawless/conversation-history.jsonl',
  conversationHistoryMaxEntries: 100,
  conversationHistoryMaxCharsPerEntry: 2000,
  conversationHistoryMaxTotalChars: 8000,
  conversationHistoryRecapTopK: 3,
  conversationSemanticRecallEnabled: true,
  conversationSemanticStorePath: '~/.clawless/conversation-semantic-memory.db',
  conversationSemanticMaxEntries: 1000,
  conversationSemanticMaxCharsPerEntry: 4000,
  schedulesFilePath: '~/.clawless/schedules.json',
};

function printHelp() {
  console.log(`clawless

Usage:
  clawless [--config [path]]

Options:
  --config [path]   Open config TUI (or use custom config path)
	-h, --help        Show this help message

Config precedence:
	1) Existing environment variables
	2) Values from config file
`);
}

function parseArgs(argv: string[]) {
  const result = {
    configPath: process.env.CLAWLESS_CONFIG || DEFAULT_CONFIG_PATH,
    help: false,
    openConfigTui: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '-h' || arg === '--help') {
      result.help = true;
      continue;
    }

    if (arg === '--config') {
      result.openConfigTui = true;
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        continue;
      }

      result.configPath = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return result;
}

function toEnvValue(value: unknown) {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function resolveEnvKey(configKey: string) {
  if (configKey in ENV_KEY_MAP) {
    return ENV_KEY_MAP[configKey];
  }

  const looksLikeEnvKey = /^[A-Z0-9_]+$/.test(configKey);
  if (looksLikeEnvKey) {
    return configKey;
  }

  return null;
}

function applyConfigToEnv(configData: Record<string, unknown>) {
  if (!configData || typeof configData !== 'object' || Array.isArray(configData)) {
    throw new Error('Config file must contain a JSON object at the top level');
  }

  for (const [configKey, rawValue] of Object.entries(configData)) {
    const envKey = resolveEnvKey(configKey);
    if (!envKey) {
      continue;
    }

    if (process.env[envKey] !== undefined) {
      continue;
    }

    const envValue = toEnvValue(rawValue);
    if (envValue !== undefined) {
      process.env[envKey] = envValue;
    }
  }
}

function resolveConfigPath(configPath: string) {
  if (!configPath || configPath === '~') {
    return os.homedir();
  }

  if (configPath.startsWith('~/')) {
    return path.join(os.homedir(), configPath.slice(2));
  }

  return path.resolve(process.cwd(), configPath);
}

function ensureConfigFile(configPath: string) {
  const absolutePath = resolveConfigPath(configPath);
  if (fs.existsSync(absolutePath)) {
    return { created: false, path: absolutePath };
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(DEFAULT_CONFIG_TEMPLATE, null, 2)}\n`, 'utf8');
  return { created: true, path: absolutePath };
}

function ensureMemoryFile(memoryFilePath: string) {
  const absolutePath = resolveConfigPath(memoryFilePath);
  if (!fs.existsSync(absolutePath)) {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const template = [
      '# Clawless Memory',
      '',
      'This file stores durable memory notes for Clawless.',
      '',
      '## Notes',
      '',
    ].join('\n');
    fs.writeFileSync(absolutePath, `${template}\n`, 'utf8');
    return { created: true, path: absolutePath };
  }

  return { created: false, path: absolutePath };
}

function ensureMemoryFromEnv() {
  const config = getConfig();
  const configuredHome = config.CLAWLESS_HOME;
  const configuredMemoryPath = config.MEMORY_FILE_PATH;

  if (!process.env.CLAWLESS_HOME) {
    process.env.CLAWLESS_HOME = configuredHome;
  }

  if (!process.env.MEMORY_FILE_PATH) {
    process.env.MEMORY_FILE_PATH = configuredMemoryPath;
  }

  return ensureMemoryFile(configuredMemoryPath);
}

function logMemoryFileCreation(memoryState: { created: boolean; path: string }) {
  if (memoryState.created) {
    console.log(`[clawless] Created memory file: ${memoryState.path}`);
  }
}

function loadConfigFile(configPath: string) {
  const absolutePath = resolveConfigPath(configPath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }

  const fileContent = fs.readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(fileContent);
  applyConfigToEnv(parsed);
  return absolutePath;
}

async function main() {
  dotenv.config();

  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const resolvedConfigPath = resolveConfigPath(args.configPath);
  const configExists = fs.existsSync(resolvedConfigPath);

  if (!configExists) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const tuiResult = await runConfigTui(args.configPath, DEFAULT_CONFIG_TEMPLATE, resolveConfigPath);
      if (!tuiResult.saved) {
        throw new Error('Config file is required. Re-run and save configuration in TUI.');
      }
    } else {
      const configState = ensureConfigFile(args.configPath);
      console.log(`[clawless] Created config template: ${configState.path}`);
      console.log('[clawless] Fill in placeholder values, then run clawless again.');
      process.exit(0);
    }
  } else if (args.openConfigTui) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('Config TUI requires an interactive terminal');
    }

    await runConfigTui(args.configPath, DEFAULT_CONFIG_TEMPLATE, resolveConfigPath);
    process.exit(0);
  }

  const loadedConfigPath = loadConfigFile(args.configPath);
  if (loadedConfigPath) {
    console.log(`[clawless] Loaded config: ${loadedConfigPath}`);
    resetConfig();
  }

  const memoryState = ensureMemoryFromEnv();
  logMemoryFileCreation(memoryState);

  const entryModuleUrl = new URL('../index.js', import.meta.url).href;
  await import(entryModuleUrl);
}

main().catch((error: any) => {
  console.error(`[clawless] ${error.message}`);
  process.exit(1);
});
