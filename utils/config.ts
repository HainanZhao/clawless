import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export function expandHomePath(value: string): string {
  if (!value || value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

const configSchema = z.object({
  MESSAGING_PLATFORM: z.enum(['telegram', 'slack']).default('telegram'),
  TELEGRAM_TOKEN: z.string().optional(),
  TELEGRAM_WHITELIST: z.string().default('[]'),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_WHITELIST: z.string().default('[]'),
  TZ: z.string().default('UTC'),
  TYPING_INTERVAL_MS: z.coerce.number().default(4000),
  STREAM_UPDATE_INTERVAL_MS: z.coerce.number().default(5000),
  CLI_AGENT: z.string().default('gemini'),
  CLI_AGENT_APPROVAL_MODE: z.string().default('yolo'),
  CLI_AGENT_MODEL: z.string().default(''),
  CLI_AGENT_TIMEOUT_MS: z.coerce.number().default(1200000),
  CLI_AGENT_NO_OUTPUT_TIMEOUT_MS: z.coerce.number().default(300000),
  CLI_AGENT_KILL_GRACE_MS: z.coerce.number().default(5000),
  ACP_PERMISSION_STRATEGY: z.string().default('allow_once'),
  ACP_PREWARM_RETRY_MS: z.coerce.number().default(30000),
  ACP_PREWARM_MAX_RETRIES: z.coerce.number().default(10),
  ACP_MCP_SERVERS_JSON: z.string().default(''),
  MAX_RESPONSE_LENGTH: z.coerce.number().default(4000),
  ACP_STREAM_STDOUT: z.preprocess((v) => String(v).toLowerCase() === 'true', z.boolean()).default(false),
  ACP_DEBUG_STREAM: z.preprocess((v) => String(v).toLowerCase() === 'true', z.boolean()).default(false),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().default(300000),
  CALLBACK_HOST: z.string().default('localhost'),
  CALLBACK_PORT: z.coerce.number().default(8788),
  CALLBACK_AUTH_TOKEN: z.string().default(''),
  CALLBACK_MAX_BODY_BYTES: z.coerce.number().default(65536),
  CLAWLESS_HOME: z
    .string()
    .optional()
    .transform((v) => expandHomePath(v || path.join(os.homedir(), '.clawless'))),
  MEMORY_FILE_PATH: z.string().optional(),
  MEMORY_MAX_CHARS: z.coerce.number().default(12000),
  CONVERSATION_HISTORY_ENABLED: z.preprocess((v) => String(v).toLowerCase() === 'true', z.boolean()).default(true),
  CONVERSATION_HISTORY_FILE_PATH: z.string().optional(),
  CONVERSATION_HISTORY_MAX_ENTRIES: z.coerce.number().default(100),
  CONVERSATION_HISTORY_MAX_CHARS_PER_ENTRY: z.coerce.number().default(2000),
  CONVERSATION_HISTORY_MAX_TOTAL_CHARS: z.coerce.number().default(8000),
  CONVERSATION_HISTORY_RECAP_TOP_K: z.coerce.number().default(3),
  CONVERSATION_SEMANTIC_RECALL_ENABLED: z
    .preprocess((v) => String(v).toLowerCase() === 'true', z.boolean())
    .default(true),
  CONVERSATION_SEMANTIC_STORE_PATH: z.string().optional(),
  CONVERSATION_SEMANTIC_MAX_ENTRIES: z.coerce.number().default(1000),
  CONVERSATION_SEMANTIC_MAX_CHARS_PER_ENTRY: z.coerce.number().default(4000),
  SCHEDULES_FILE_PATH: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

let cachedConfig: Config | null = null;

export function resetConfig() {
  cachedConfig = null;
}

export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const result = configSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid configuration:');
    for (const error of result.error.issues) {
      console.error(`  - ${error.path.join('.')}: ${error.message}`);
    }
    process.exit(1);
  }

  const validatedConfig = result.data;

  // Final path resolution for dependent paths
  const config = {
    ...validatedConfig,
    MEMORY_FILE_PATH: expandHomePath(
      validatedConfig.MEMORY_FILE_PATH || path.join(validatedConfig.CLAWLESS_HOME, 'MEMORY.md'),
    ),
    SCHEDULES_FILE_PATH: expandHomePath(
      validatedConfig.SCHEDULES_FILE_PATH || path.join(validatedConfig.CLAWLESS_HOME, 'schedules.json'),
    ),
    CONVERSATION_HISTORY_FILE_PATH: expandHomePath(
      validatedConfig.CONVERSATION_HISTORY_FILE_PATH ||
        path.join(validatedConfig.CLAWLESS_HOME, 'conversation-history.jsonl'),
    ),
    CONVERSATION_SEMANTIC_STORE_PATH: expandHomePath(
      validatedConfig.CONVERSATION_SEMANTIC_STORE_PATH ||
        path.join(validatedConfig.CLAWLESS_HOME, 'conversation-semantic-memory.db'),
    ),
  };

  // Perform conditional validation
  if (config.MESSAGING_PLATFORM === 'telegram') {
    if (!config.TELEGRAM_TOKEN) {
      console.error('❌ Error: TELEGRAM_TOKEN environment variable is required for Telegram');
      process.exit(1);
    }
    if (config.TELEGRAM_TOKEN.includes('your_telegram_bot_token_here') || !config.TELEGRAM_TOKEN.includes(':')) {
      console.error('❌ Error: TELEGRAM_TOKEN looks invalid. Set a real token from @BotFather in your config/env.');
      process.exit(1);
    }
  }

  if (config.MESSAGING_PLATFORM === 'slack') {
    if (!config.SLACK_BOT_TOKEN) {
      console.error('❌ Error: SLACK_BOT_TOKEN environment variable is required for Slack');
      process.exit(1);
    }
    if (!config.SLACK_SIGNING_SECRET) {
      console.error('❌ Error: SLACK_SIGNING_SECRET environment variable is required for Slack');
      process.exit(1);
    }
  }

  cachedConfig = config;
  return config;
}
