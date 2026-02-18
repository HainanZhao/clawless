# AGENTS

This document is the developer/operator handbook for Clawless.

## Local Development Setup

1. Install dependencies:

```bash
npm install
```

2. Create local environment file:

```bash
cp .env.example .env
```

3. Edit `.env` and set at least:

```env
MESSAGING_PLATFORM=telegram
TELEGRAM_TOKEN=your_bot_token_here
# For Slack mode set MESSAGING_PLATFORM=slack and configure:
# SLACK_BOT_TOKEN=xoxb-your-bot-token
# SLACK_SIGNING_SECRET=your-signing-secret
# SLACK_WHITELIST=["U01234567","user@example.com"]
# For email-based allowlist entries, add OAuth scopes: users:read and users:read.email

# CLI Agent Selection (default: gemini)
CLI_AGENT=gemini
# CLI_AGENT=opencode
# CLI_AGENT=claude

# CLI Agent settings
TYPING_INTERVAL_MS=4000
CLI_AGENT_TIMEOUT_MS=1200000
CLI_AGENT_NO_OUTPUT_TIMEOUT_MS=300000
ACP_STREAM_STDOUT=false
ACP_DEBUG_STREAM=false
```

## Run Locally

- CLI entry (same behavior as published binary):

```bash
npm run cli
```

- Development watch mode:

```bash
npm run dev
```

- Production-style local run:

```bash
npm start
```

## Quality Checks

```bash
npm run lint
npx tsc -p tsconfig.json --noEmit
```

## Runtime Configuration

Canonical config/env key mapping is documented in [README.md](README.md) under “Configuration Reference (Consolidated)”. Keep that section as the source of truth.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MESSAGING_PLATFORM` | No | telegram | Active messaging platform (`telegram` or `slack`) |
| `TELEGRAM_TOKEN` | Yes (telegram) | - | Your Telegram bot token from BotFather |
| `SLACK_BOT_TOKEN` | Yes (slack) | - | Slack bot token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Yes (slack) | - | Slack app signing secret |
| `SLACK_APP_TOKEN` | No | - | Slack Socket Mode app token (`xapp-...`) |
| `SLACK_WHITELIST` | Yes (slack) | - | List of authorized Slack principals (user IDs or emails). Must be a non-empty JSON array and should stay small (max 10 users). Format: `["U01234567", "user@example.com"]`. Email matching requires OAuth scopes `users:read` and `users:read.email`. |
| `TELEGRAM_WHITELIST` | Yes (telegram) | - | List of authorized Telegram usernames. Must be a non-empty JSON array and should stay small (max 10 users). Format: `["username1", "username2"]` |
| `TYPING_INTERVAL_MS` | No | 4000 | Interval (in milliseconds) for refreshing typing status |
| `STREAM_UPDATE_INTERVAL_MS` | No | 5000 | Interval (in milliseconds) between progressive response message updates |
| `CLI_AGENT` | No | gemini | CLI agent type to use (`gemini`, `opencode`, or `claude`) |
| `CLI_AGENT_TIMEOUT_MS` | No | 1200000 | Overall timeout for a single CLI agent run |
| `CLI_AGENT_NO_OUTPUT_TIMEOUT_MS` | No | 300000 | Idle timeout; aborts if CLI agent emits no output for this duration |
| `CLI_AGENT_KILL_GRACE_MS` | No | 5000 | Grace period after SIGTERM before escalating CLI agent child process shutdown to SIGKILL |
| `CLI_AGENT_APPROVAL_MODE` | No | yolo | CLI agent approval mode (`default`, `auto_edit`, `yolo`, `plan`) |
| `CLI_AGENT_MODEL` | No | - | CLI agent model override passed to the CLI |
| `ACP_PERMISSION_STRATEGY` | No | allow_once | Auto-select ACP permission option kind (`allow_once`, `reject_once`, `cancelled`) |
| `ACP_STREAM_STDOUT` | No | false | Writes raw ACP text chunks to stdout as they arrive |
| `ACP_DEBUG_STREAM` | No | false | Writes structured ACP chunk timing/count debug logs |
| `MAX_RESPONSE_LENGTH` | No | 4000 | Maximum response length in characters |
| `HEARTBEAT_INTERVAL_MS` | No | 300000 | Server heartbeat log interval in milliseconds (`0` disables logs) |
| `CALLBACK_HOST` | No | 127.0.0.1 | Bind address for callback server |
| `CALLBACK_PORT` | No | 8788 | Bind port for callback server |
| `CALLBACK_AUTH_TOKEN` | No | - | Optional bearer/token guard for callback endpoint |
| `CALLBACK_MAX_BODY_BYTES` | No | 65536 | Maximum accepted callback request body size |
| `CLAWLESS_HOME` | No | ~/.clawless | Home directory for runtime files |
| `MEMORY_FILE_PATH` | No | ~/.clawless/MEMORY.md | Persistent memory file path injected into agent prompt context |
| `MEMORY_MAX_CHARS` | No | 12000 | Max memory-file characters injected into prompt context |
| `CONVERSATION_HISTORY_ENABLED` | No | true | Enable/disable conversation history tracking and injection |
| `CONVERSATION_HISTORY_FILE_PATH` | No | ~/.clawless/conversation-history.jsonl | Conversation history JSONL file path |
| `CONVERSATION_HISTORY_MAX_ENTRIES` | No | 100 | Maximum number of conversation entries to keep (FIFO rotation) |
| `CONVERSATION_HISTORY_MAX_CHARS_PER_ENTRY` | No | 2000 | Maximum characters per conversation entry (truncates longer messages) |
| `CONVERSATION_HISTORY_MAX_TOTAL_CHARS` | No | 8000 | Maximum total characters to inject into prompt context |
| `CONVERSATION_HISTORY_RECAP_TOP_K` | No | 3 | Number of relevant historical entries selected for recap via similarity ranking |
| `CONVERSATION_SEMANTIC_RECALL_ENABLED` | No | true | Enable/disable semantic recap retrieval using local SQLite FTS lexical ranking |
| `CONVERSATION_SEMANTIC_STORE_PATH` | No | ~/.clawless/conversation-semantic-memory.db | Persistent semantic recall SQLite file path |
| `CONVERSATION_SEMANTIC_MAX_ENTRIES` | No | 1000 | Maximum semantic entries kept in local recall store (FIFO rotation) |
| `CONVERSATION_SEMANTIC_MAX_CHARS_PER_ENTRY` | No | 4000 | Maximum characters from each conversation entry used for lexical recall indexing |
| `SCHEDULES_FILE_PATH` | No | ~/.clawless/schedules.json | Persistent scheduler storage file |

### Local Callback Endpoint

- `POST http://127.0.0.1:8788/callback` - Send messages to active messaging platform
- `POST http://127.0.0.1:8788/callback/telegram` - Telegram-compatible callback alias
- `POST http://127.0.0.1:8788/callback/slack` - Slack callback alias (when Slack platform is active)
- `GET http://127.0.0.1:8788/healthz` - Health check
- `POST/GET/DELETE http://127.0.0.1:8788/api/schedule`, `GET/PATCH http://127.0.0.1:8788/api/schedule/:id` - Scheduler API
- `POST http://127.0.0.1:8788/api/memory/semantic-recall` - On-demand semantic recall API (`input`, optional `chatId`, optional `topK`)

Request body for callback:

```json
{
  "text": "Nightly job finished successfully"
}
```

- `chatId` is optional; if omitted, the bridge sends to a persisted chat binding learned from inbound platform messages/events.
- To bind once, send any message to the bot from your target chat.
- If `CALLBACK_AUTH_TOKEN` is set, send either `x-callback-token: <token>` or `Authorization: Bearer <token>`.

Cron-friendly example:

```bash
curl -sS -X POST "http://127.0.0.1:8788/callback" \
  -H "Content-Type: application/json" \
  -H "x-callback-token: $CALLBACK_AUTH_TOKEN" \
  -d '{"text":"Backup completed at 03:00"}'
```

Semantic recall example:

```bash
curl -sS -X POST "http://127.0.0.1:8788/api/memory/semantic-recall" \
  -H "Content-Type: application/json" \
  -H "x-callback-token: $CALLBACK_AUTH_TOKEN" \
  -d '{
    "input": "What did we decide about semantic memory design?",
    "chatId": "D0AF7JTCB70",
    "topK": 3
  }'
```

### Scheduler API

- Schedules persist to disk and are reloaded on restart.
- Default storage path: `~/.clawless/schedules.json` (override with `SCHEDULES_FILE_PATH`).
- Update schedules through API only; do not edit `schedules.json` directly.

Create recurring schedule:

```bash
curl -X POST http://127.0.0.1:8788/api/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Check my calendar and send me a summary",
    "description": "Daily calendar summary",
    "cronExpression": "0 9 * * *"
  }'
```

Create one-time schedule:

```bash
curl -X POST http://127.0.0.1:8788/api/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Remind me to take a break",
    "oneTime": true,
    "runAt": "2026-02-13T15:30:00Z"
  }'
```

Update schedule:

```bash
curl -X PATCH http://127.0.0.1:8788/api/schedule/<schedule_id> \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Updated reminder",
    "cronExpression": "0 10 * * *"
  }'
```

See [doc/SCHEDULER.md](doc/SCHEDULER.md) for complete API details.

### Persistent Memory File

- Ensures memory file exists at `~/.clawless/MEMORY.md` on startup.
- Agent runtime is started with include access to both `~/.clawless` and `~/`.
- ACP session setup uses required `mcpServers` with an empty array and relies on Gemini CLI defaults for MCP/skills loading.
- Prompts include memory instructions and current `MEMORY.md` content.

### Timeout Tuning

- `CLI_AGENT_TIMEOUT_MS`: hard cap for total request time (recommended: `1200000`)
- `CLI_AGENT_NO_OUTPUT_TIMEOUT_MS`: fail fast if output stalls (recommended: `300000`)
- Set `CLI_AGENT_NO_OUTPUT_TIMEOUT_MS=0` to disable idle timeout

### Response Length Limit

- Default: 4000 characters (chosen as a conservative cross-platform default)
- Longer outputs are truncated with a notification

## Internal Behavior

### Processing Flow

1. User sends a message via Telegram or Slack.
2. Bridge queues the message if another request is in progress.
3. Worker dequeues when prior processing completes.
4. Agent run starts and typing status is shown.
5. Final reply is sent when run finishes.

### Queueing Behavior

- Single-worker in-memory queue
- Prevents overlapping runs
- Preserves message order
- Avoids duplicate-edit/fallback races

## Troubleshooting

### Bot does not respond

1. Check CLI agent installation:

```bash
which gemini  # for Gemini CLI
which opencode  # for OpenCode
```

Or check your configured CLI agent:

```bash
which gemini
# or
which opencode
```

2. Verify ACP support:

```bash
gemini --help | grep acp  # for Gemini
opencode --help | grep acp  # for OpenCode
```

3. Check bot logs for runtime errors.

### Rate limit errors

- Increase `TYPING_INTERVAL_MS` (for example to `5000` or higher).
- Restart the process.

### Connection issues

- Verify internet access.
- Check platform API reachability.
- Ensure platform credentials are correct (`TELEGRAM_TOKEN` for Telegram, Slack credentials for Slack).

## Codebase Notes

### Project Structure

```text
Clawless/
├── index.ts                        # Main bridge application
├── bin/
│   └── cli.ts                      # CLI entrypoint
├── core/
│   ├── agents/                     # CLI agent abstraction
│   │   ├── BaseCliAgent.ts         # Abstract base class for agents
│   │   ├── GeminiAgent.ts          # Gemini CLI implementation
│   │   ├── OpencodeAgent.ts        # OpenCode implementation
│   │   └── agentFactory.ts         # Agent factory and validation
│   └── callbackServer.ts           # Callback/API server
├── messaging/
│   ├── telegramClient.ts           # Telegram adapter
│   └── slackClient.ts              # Slack adapter
├── scheduler/
│   ├── cronScheduler.ts            # Schedule persistence + cron orchestration
│   └── scheduledJobHandler.ts      # Scheduled run execution logic
├── acp/
│   ├── runtimeManager.ts           # Agent-agnostic ACP runtime
│   ├── tempAcpRunner.ts            # Isolated ACP run helper
│   └── clientHelpers.ts            # ACP helper utilities
├── package.json                    # Node.js dependencies
├── ecosystem.config.json           # PM2 configuration
├── clawless.config.example.json    # CLI config template
└── README.md                       # User-facing docs
```

### Extension Points

- Core queue + ACP logic: `index.ts`
- Messaging adapter logic: `messaging/telegramClient.ts`, `messaging/slackClient.ts`
- CLI agent implementations: `core/agents/`
- New interfaces can implement the same message context shape (`text`, `startTyping()`, `sendText()`).

### Adding New CLI Agents

To add support for a new ACP-capable CLI agent:

1. Create a new agent class in `core/agents/`:
   ```typescript
   import { BaseCliAgent, type CliAgentCapabilities, type CliAgentConfig } from './BaseCliAgent.js';
   
   export class MyNewAgent extends BaseCliAgent {
     getCommand(): string {
       return this.config.command;
     }
     
     getDisplayName(): string {
       return 'My New Agent';
     }
     
     buildAcpArgs(): string[] {
       const args = ['--experimental-acp'];
       // Add agent-specific arguments
       return args;
     }
     
     getCapabilities(): CliAgentCapabilities {
       return {
         supportsAcp: true,
         supportsApprovalMode: true,
         supportsModelSelection: true,
         supportsIncludeDirectories: true,
       };
     }
     
     validate(): { valid: boolean; error?: string } {
       // Validate the agent is installed
       return { valid: true };
     }
   }
   ```

2. Add the agent to `core/agents/agentFactory.ts`:
   ```typescript
   export const SUPPORTED_AGENTS = ['gemini', 'opencode', 'claude', 'mynewagent'] as const;
   export type AgentType = (typeof SUPPORTED_AGENTS)[number];
   
   export function createCliAgent(agentType: AgentType, config: CliAgentConfig): BaseCliAgent {
     switch (agentType) {
       case 'gemini':
         return new GeminiAgent(config);
       case 'opencode':
         return new OpencodeAgent(config);
       case 'claude':
         return new ClaudeCodeAgent(config);
       case 'mynewagent':
         return new MyNewAgent(config);
     }
   }
   ```

3. Export the new agent from `core/agents/index.ts`

4. Add the agent type to `SUPPORTED_AGENTS` in `core/agents/agentFactory.ts` (this also automatically updates the config TUI since it imports from there)

5. Set `CLI_AGENT=mynewagent` in configuration

The agent abstraction handles all the runtime integration automatically.

## Security Notes

- Never commit `.env`.
- Rotate tokens if exposed.
- Limit bot access via Telegram settings and whitelist.
- Monitor logs for unusual activity.
