# Telegram-Gemini ACP Bridge

A bridge that connects a Telegram bot to the Gemini CLI using the Agent Communication Protocol (ACP). This turns Telegram into a "remote terminal" for your local Gemini agent, enabling rich tool use and persistent context.

## Features

- 🤖 **Telegram Bot Interface**: Interact with Gemini CLI through Telegram
- ⌨️ **Typing Status UX**: Shows Telegram typing indicator while Gemini is processing
- 🛠️ **Rich Tool Support**: Leverages MCP (Model Context Protocol) servers connected to Gemini CLI
- 🔒 **Privacy**: Runs on your hardware, you control data flow
- 💾 **Persistent Context**: Maintains local session unlike standard API calls
- 📬 **Sequential Queueing**: Processes one message at a time to avoid overlap and races
- 🔔 **Local Callback Endpoint**: Accepts localhost HTTP POST requests and forwards payloads directly to Telegram
- ⏰ **Cron Scheduler**: Schedule tasks to run at specific times or on recurring basis via REST API

## Architecture

```
┌──────────┐         ┌───────────┐         ┌─────────────┐
│ Telegram │ ◄─────► │  Bridge   │ ◄─────► │ Gemini CLI  │
│   User   │         │ (Node.js) │   ACP   │   (Local)   │
└──────────┘         └───────────┘         └─────────────┘
```

The bridge:
1. Receives messages from Telegram users
2. Forwards them to the Gemini CLI via ACP (Agent Communication Protocol)
3. Shows typing status, then sends a single final response

## Prerequisites

- **Node.js** 18.0.0 or higher
- **Gemini CLI** installed and configured with ACP support
- **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/HainanZhao/RemoteAgent.git
cd RemoteAgent
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
```

Edit `.env` and add your Telegram bot token:
```env
TELEGRAM_TOKEN=your_bot_token_here
TYPING_INTERVAL_MS=4000
GEMINI_TIMEOUT_MS=900000
GEMINI_NO_OUTPUT_TIMEOUT_MS=60000
ACP_STREAM_STDOUT=false
ACP_DEBUG_STREAM=false
```

## Getting a Telegram Bot Token

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` command
3. Follow the prompts to create your bot
4. Copy the token provided by BotFather
5. Paste it into your `.env` file

## Usage

### CLI Mode

After install, the package exposes a CLI command:

```bash
gemini-bridge
```

Local development alternatives:

```bash
npm run cli
npx gemini-bridge
```

### Config File (CLI)

On first run, the CLI automatically creates:

```text
~/.gemini-bridge/config.json
```

with placeholder values, then exits so you can edit it.

After updating placeholders, run again:

```bash
gemini-bridge
```

You can also use a custom path:

```bash
gemini-bridge --config /path/to/config.json
```

If the custom config path does not exist, a template file is created there as well.

You can still bootstrap from the example file if preferred:

```bash
cp gemini-bridge.config.example.json ~/.gemini-bridge/config.json
```

Environment variables still work and take precedence over config values.

### Run In Background

Simple background run:

```bash
nohup gemini-bridge > gemini-bridge.log 2>&1 &
```

Recommended for production: PM2 (see section below).

### Development Mode

```bash
npm run dev
```

This runs the bot with Node.js watch mode for automatic restarts on file changes.

### Production Mode

```bash
npm start
```

### Using PM2 (Recommended for Production)

PM2 keeps your bridge running continuously and restarts it automatically if it crashes.

1. Install PM2 globally:
```bash
npm install -g pm2
```

2. Start the bridge:
```bash
pm2 start ecosystem.config.json
```

PM2 will automatically create the `logs/` directory for log files.

3. View logs:
```bash
pm2 logs telegram-gemini-bridge
```

4. Manage the process:
```bash
pm2 status                    # View status
pm2 restart telegram-gemini-bridge  # Restart
pm2 stop telegram-gemini-bridge     # Stop
pm2 delete telegram-gemini-bridge   # Remove from PM2
```

5. Set up auto-start on system boot:
```bash
pm2 startup
pm2 save
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_TOKEN` | Yes | - | Your Telegram bot token from BotFather |
| `TYPING_INTERVAL_MS` | No | 4000 | Interval (in milliseconds) for refreshing Telegram typing status |
| `GEMINI_TIMEOUT_MS` | No | 900000 | Overall timeout for a single Gemini CLI run |
| `GEMINI_NO_OUTPUT_TIMEOUT_MS` | No | 60000 | Idle timeout; aborts if Gemini emits no output for this duration |
| `GEMINI_KILL_GRACE_MS` | No | 5000 | Grace period after SIGTERM before escalating Gemini child process shutdown to SIGKILL |
| `GEMINI_APPROVAL_MODE` | No | yolo | Gemini approval mode (for example: `default`, `auto_edit`, `yolo`, `plan`) |
| `GEMINI_MODEL` | No | - | Gemini model override passed to CLI |
| `ACP_PERMISSION_STRATEGY` | No | allow_once | Auto-select ACP permission option kind (`allow_once`, `reject_once`, or `cancelled`) |
| `ACP_STREAM_STDOUT` | No | false | Writes raw ACP text chunks to stdout as they arrive |
| `ACP_DEBUG_STREAM` | No | false | Writes structured ACP chunk timing/count debug logs |
| `MAX_RESPONSE_LENGTH` | No | 4000 | Maximum response length in characters to prevent memory issues |
| `HEARTBEAT_INTERVAL_MS` | No | 60000 | Server heartbeat log interval in milliseconds (`0` disables heartbeat logs) |
| `CALLBACK_HOST` | No | 127.0.0.1 | Bind address for callback server |
| `CALLBACK_PORT` | No | 8787 | Bind port for callback server |
| `CALLBACK_AUTH_TOKEN` | No | - | Optional bearer/token guard for callback endpoint |
| `CALLBACK_MAX_BODY_BYTES` | No | 65536 | Maximum accepted callback request body size |
| `AGENT_BRIDGE_HOME` | No | ~/.gemini-bridge | Home directory for Gemini Bridge runtime files |
| `MEMORY_FILE_PATH` | No | ~/.gemini-bridge/MEMORY.md | Persistent memory file path injected into Gemini prompt context |
| `MEMORY_MAX_CHARS` | No | 12000 | Max memory-file characters injected into prompt context |
| `SCHEDULES_FILE_PATH` | No | ~/.gemini-bridge/schedules.json | Persistent scheduler storage file |

### Local Callback Endpoint

The bridge exposes:

- `POST http://127.0.0.1:8787/callback/telegram` - Send messages to Telegram
- `GET http://127.0.0.1:8787/healthz` - Health check
- `POST/GET/DELETE http://127.0.0.1:8787/api/schedule`, `GET http://127.0.0.1:8787/api/schedule/:id` - Scheduler API

Request body for callback:

```json
{
  "text": "Nightly job finished successfully"
}
```

- `chatId` is optional. If omitted, the bridge sends to a persisted chat binding learned from inbound Telegram messages.
- To bind once, send any message to the bot from your target chat.
- If `CALLBACK_AUTH_TOKEN` is set, send either `x-callback-token: <token>` or `Authorization: Bearer <token>`.

Cron-friendly example:

```bash
curl -sS -X POST "http://127.0.0.1:8787/callback/telegram" \
  -H "Content-Type: application/json" \
  -H "x-callback-token: $CALLBACK_AUTH_TOKEN" \
  -d '{"text":"Backup completed at 03:00"}'
```

### Scheduler API

The bridge includes a built-in cron scheduler that allows you to schedule tasks to be executed through Gemini CLI:

- Schedules are persisted to disk and automatically reloaded on restart.
- Default storage path: `~/.gemini-bridge/schedules.json` (override with `SCHEDULES_FILE_PATH`).

**Create a recurring schedule:**
```bash
curl -X POST http://127.0.0.1:8787/api/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Check my calendar and send me a summary",
    "description": "Daily calendar summary",
    "cronExpression": "0 9 * * *"
  }'
```

**Create a one-time schedule:**
```bash
curl -X POST http://127.0.0.1:8787/api/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Remind me to take a break",
    "oneTime": true,
    "runAt": "2026-02-13T15:30:00Z"
  }'
```

When a scheduled job runs, it executes the message through Gemini CLI and sends the response to your Telegram chat.

**Ask Gemini to create schedules naturally:**
- "Remind me to take a break in 30 minutes"
- "Check my calendar every morning at 9am and send me a summary"
- "Every Friday at 5pm, remind me to review my weekly goals"

See [SCHEDULER.md](SCHEDULER.md) for complete API documentation.

### Persistent Memory File

- The bridge ensures a memory file exists at `~/.gemini-bridge/MEMORY.md` on startup.
- Gemini is started with include access to both `~/.gemini-bridge` and your full home directory (`~/`).
- ACP session setup uses the required `mcpServers` field with an empty array and relies on Gemini CLI runtime defaults for MCP/skills loading.
- Each prompt includes memory instructions and current `MEMORY.md` content.
- When asked to memorize/remember something, Gemini is instructed to append new notes under `## Notes`.

### Timeout Tuning

Use both timeouts together for reliability:

- `GEMINI_TIMEOUT_MS`: hard cap for total request time (recommended: `900000`)
- `GEMINI_NO_OUTPUT_TIMEOUT_MS`: fail fast if output stalls (recommended: `60000`)
- Set `GEMINI_NO_OUTPUT_TIMEOUT_MS=0` to disable idle timeout

### Response Length Limit

The `MAX_RESPONSE_LENGTH` prevents memory issues with very long responses:

- **Default**: 4000 characters (Telegram's limit is 4096 per message)
- Responses exceeding this limit are truncated with a notification
- Protects against unbounded memory growth

## How It Works

### The Logic Flow

1. **User sends a message** via Telegram
2. **Bridge queues** the message if another request is in progress
3. **Worker dequeues** the next message when prior processing completes
4. **Gemini run starts** and typing status is shown in Telegram
5. **Single final reply** is sent when Gemini finishes

### Queueing Behavior

The bridge uses a single-worker in-memory queue:
- Prevents overlapping Gemini runs
- Preserves message order
- Avoids duplicate-edit/fallback races from message updates

## Advantages Over Standard API Bots

1. **Persistent Context**: The Gemini CLI maintains a local session, unlike stateless API calls
2. **Local File Access**: Can access files on your server if configured
3. **MCP Tool Integration**: Automatically uses tools from connected MCP servers (Calendar, Database, etc.)
4. **Privacy Control**: Runs on your hardware, you control data processing
5. **Custom Configuration**: Use your specific Gemini CLI setup and preferences

## Troubleshooting

### Bot doesn't respond

1. Check if Gemini CLI is installed:
```bash
which gemini
```

2. Verify Gemini CLI supports ACP:
```bash
gemini --help | grep acp
```

3. Check bot logs for errors

### Rate limit errors

If you see "429 Too Many Requests" errors:
1. Increase `TYPING_INTERVAL_MS` in `.env` (try 5000 or higher)
2. Restart the bot

### Connection issues

1. Verify your internet connection
2. Check if Telegram API is accessible
3. Ensure `TELEGRAM_TOKEN` is correct in `.env`

## Development

### Project Structure

```
RemoteAgent/
├── index.ts              # Main bridge application
├── messaging/
│   └── telegramClient.ts # Telegram adapter implementing neutral message context
├── package.json          # Node.js dependencies
├── ecosystem.config.json # PM2 configuration
├── .env.example          # Environment variables template
├── .env                  # Your local configuration (not in git)
└── README.md            # This file
```

### Adding Features

The codebase is designed to be simple and extensible:
- Core queue + ACP logic is in `index.ts`
- Messaging-platform specifics live in `messaging/telegramClient.ts`
- New bot platforms can implement the same message context shape (`text`, `startTyping()`, `sendText()`)
- Error handling is centralized
- Rate limiting logic is configurable

## Security Considerations

- **Never commit** `.env` file with your token (it's in `.gitignore`)
- **Rotate tokens** if accidentally exposed
- **Limit bot access** using Telegram's bot settings
- **Monitor logs** for unusual activity

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) file for details

## Credits

Built with:
- [Telegraf](https://telegraf.js.org/) - Telegram Bot framework
- [@agentclientprotocol/sdk](https://www.npmjs.com/package/@agentclientprotocol/sdk) - Agent Communication Protocol SDK

## Support

For issues and questions:
- Open an issue on GitHub
- Check existing issues for solutions
- Review Gemini CLI documentation

---

**Note**: This bridge requires a working Gemini CLI installation with ACP support. Ensure your CLI is properly configured before running the bridge.
