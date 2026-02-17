# Configuration Reference

This document lists `config.json` keys, defaults, and what each setting controls.

| Key | Default | Meaning |
|---|---|---|
| `messagingPlatform` | `telegram` | Active interface adapter (`telegram` or `slack`). |
| `telegramToken` | `your_telegram_bot_token_here` | Telegram bot token from BotFather (required in Telegram mode). |
| `telegramWhitelist` | `[]` | Allowed Telegram usernames (required and non-empty in Telegram mode). |
| `slackBotToken` | `""` | Slack bot token (required in Slack mode). |
| `slackSigningSecret` | `""` | Slack signing secret (required in Slack mode). |
| `slackAppToken` | `""` | Optional Slack Socket Mode app token. |
| `slackWhitelist` | `[]` | Allowed Slack user IDs/emails (required and non-empty in Slack mode). |
| `timezone` | `UTC` | Timezone used by scheduler cron execution. |
| `typingIntervalMs` | `4000` | Typing indicator refresh interval while processing. |
| `streamUpdateIntervalMs` | `5000` | Minimum interval between progressive streaming message updates. |
| `geminiCommand` | `gemini` | Agent CLI executable name/path. |
| `geminiApprovalMode` | `yolo` | Gemini approval mode (`default`, `auto_edit`, `yolo`, `plan`). |
| `geminiModel` | `""` | Optional Gemini model override. |
| `acpPermissionStrategy` | `allow_once` | Auto selection strategy for ACP permission prompts. |
| `geminiTimeoutMs` | `1200000` | Hard timeout for one agent run (ms). |
| `geminiNoOutputTimeoutMs` | `300000` | Idle timeout when no output is produced (ms). |
| `geminiKillGraceMs` | `5000` | Grace period before forced process kill after termination (ms). |
| `acpPrewarmRetryMs` | `30000` | Delay before retrying ACP prewarm after failure (ms). |
| `acpPrewarmMaxRetries` | `10` | Max prewarm retries (`0` = unlimited). |
| `acpMcpServersJson` | `""` | Optional JSON override for ACP MCP server list. |
| `acpStreamStdout` | `false` | Emit raw ACP stream chunks to stdout. |
| `acpDebugStream` | `false` | Emit structured ACP stream debug logs. |
| `maxResponseLength` | `4000` | Max outbound response length in characters. |
| `heartbeatIntervalMs` | `60000` | Heartbeat log interval (`0` disables heartbeat logs). |
| `callbackHost` | `localhost` | Bind host for local callback/API server. |
| `callbackPort` | `8788` | Bind port for local callback/API server. |
| `callbackAuthToken` | `""` | Optional auth token for callback and local API routes. |
| `callbackMaxBodyBytes` | `65536` | Max accepted callback/API request body size. |
| `agentBridgeHome` | `~/.clawless` | Base directory for runtime state files. |
| `memoryFilePath` | `~/.clawless/MEMORY.md` | Persistent memory note file injected into prompt context. |
| `memoryMaxChars` | `12000` | Max memory-file characters included in prompt context. |
| `conversationHistoryEnabled` | `true` | Enable/disable conversation history tracking. |
| `conversationHistoryFilePath` | `~/.clawless/conversation-history.jsonl` | Conversation history JSONL file path. |
| `conversationHistoryMaxEntries` | `100` | Max retained conversation entries (FIFO). |
| `conversationHistoryMaxCharsPerEntry` | `2000` | Max chars stored per user/assistant entry. |
| `conversationHistoryMaxTotalChars` | `8000` | Max chars used when formatting recap context. |
| `conversationHistoryRecapTopK` | `4` | Default number of entries returned for recap/semantic API output. |
| `conversationSemanticRecallEnabled` | `true` | Enable/disable semantic recall features. |
| `conversationSemanticModelPath` | `hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf` | Embedding model path (supports `hf:` URI). |
| `conversationSemanticStorePath` | `~/.clawless/conversation-semantic-memory.db` | SQLite semantic embedding store file path. |
| `conversationSemanticMaxEntries` | `1000` | Max retained semantic entries (FIFO). |
| `conversationSemanticMaxCharsPerEntry` | `4000` | Max chars per entry used to build embeddings. |
| `conversationSemanticTimeoutMs` | `15000` | Timeout for semantic embed/query operations. |
| `schedulesFilePath` | `~/.clawless/schedules.json` | Scheduler persistence file path. |
