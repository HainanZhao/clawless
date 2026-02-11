# Telegram-Gemini ACP Bridge

A bridge that connects a Telegram bot to the Gemini CLI using the Agent Communication Protocol (ACP). This turns Telegram into a "remote terminal" for your local Gemini agent, enabling rich tool use and persistent context.

## Features

- 🤖 **Telegram Bot Interface**: Interact with Gemini CLI through Telegram
- 🔄 **Real-time Streaming**: Messages stream back to Telegram with live updates
- 🛠️ **Rich Tool Support**: Leverages MCP (Model Context Protocol) servers connected to Gemini CLI
- 🔒 **Privacy**: Runs on your hardware, you control data flow
- 💾 **Persistent Context**: Maintains local session unlike standard API calls
- ⚡ **Rate Limit Protection**: Smart message buffering to respect Telegram API limits

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
3. Streams responses back to Telegram in real-time

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
UPDATE_INTERVAL_MS=1500
```

## Getting a Telegram Bot Token

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` command
3. Follow the prompts to create your bot
4. Copy the token provided by BotFather
5. Paste it into your `.env` file

## Usage

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
| `UPDATE_INTERVAL_MS` | No | 1500 | Interval (in milliseconds) for updating Telegram messages during streaming |
| `MAX_RESPONSE_LENGTH` | No | 4000 | Maximum response length in characters to prevent memory issues |

### Update Interval

The `UPDATE_INTERVAL_MS` controls how often the bot updates messages while streaming:

- **Lower values (500-1000ms)**: More real-time feel, but higher API usage
- **Higher values (1500-2000ms)**: Better for rate limits, slight delay in updates
- **Recommended**: 1500ms balances responsiveness and API limits

### Response Length Limit

The `MAX_RESPONSE_LENGTH` prevents memory issues with very long responses:

- **Default**: 4000 characters (Telegram's limit is 4096 per message)
- Responses exceeding this limit are truncated with a notification
- Protects against unbounded memory growth

## How It Works

### The Logic Flow

1. **User sends a message** via Telegram
2. **Bridge receives** the message and sends initial "Thinking..." response
3. **ACP handshake** forwards the message to Gemini CLI
4. **Streaming**: As Gemini CLI streams tokens back via ACP:
   - Bridge collects tokens
   - Updates Telegram message at intervals (respecting rate limits)
   - Shows real-time progress to user
5. **Final update** ensures complete response is displayed

### Rate Limit Protection

The bridge implements smart buffering to avoid Telegram's rate limits:
- Messages are only updated at configured intervals
- Prevents "429 Too Many Requests" errors
- Handles edit failures gracefully

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
1. Increase `UPDATE_INTERVAL_MS` in `.env` (try 2000 or higher)
2. Restart the bot

### Connection issues

1. Verify your internet connection
2. Check if Telegram API is accessible
3. Ensure `TELEGRAM_TOKEN` is correct in `.env`

## Development

### Project Structure

```
RemoteAgent/
├── index.js              # Main bridge application
├── package.json          # Node.js dependencies
├── ecosystem.config.json # PM2 configuration
├── .env.example          # Environment variables template
├── .env                  # Your local configuration (not in git)
└── README.md            # This file
```

### Adding Features

The codebase is designed to be simple and extensible:
- Message handling is in the `bot.on('text', ...)` handler
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
- [Vercel AI SDK](https://sdk.vercel.ai/) - AI integration toolkit
- [@ai-sdk/acp](https://www.npmjs.com/package/@ai-sdk/acp) - Agent Communication Protocol provider

## Support

For issues and questions:
- Open an issue on GitHub
- Check existing issues for solutions
- Review Gemini CLI documentation

---

**Note**: This bridge requires a working Gemini CLI installation with ACP support. Ensure your CLI is properly configured before running the bridge.
