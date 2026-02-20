# Gemini Agent Context for Clawless (formerly AgentBridge)

## Project Overview

Clawless is a TypeScript-based agent bridge system designed to integrate various services (like Jira, GitLab, Slack, Telegram) with local CLI agents. It acts as a central hub for task automation, proactive notifications, and chat-based operations.

## Architecture

- **Core:** Node.js/TypeScript application.
- **Runtime:** Managed by PM2 (`ecosystem.config.json`).
- **Database:** SQLite (via `sql.js`) for semantic memory.
- **Messaging:** Supports Telegram (`messaging/telegramClient.ts`) and Slack (`messaging/slackClient.ts`).
- **Scheduler:** Built-in cron scheduler (`scheduler/cronScheduler.ts`) for periodic tasks.
- **Memory:** Semantic memory using vector embeddings (`utils/semanticConversationMemory.ts`) and local models (`gguf`).

## Key Directories

- `acp/`: Agent Control Protocol implementation.
- `bin/`: CLI entry points.
- `core/`: Core server logic.
- `messaging/`: Chat platform integrations.
- `scheduler/`: Job scheduling logic.
- `utils/`: Shared utilities (memory, error handling, http).
- `scripts/`: Shell scripts for maintenance and testing.

## Asynchronous Hybrid Mode

Clawless supports a sophisticated hybrid conversation mode that intelligently balances responsiveness with deep task execution.

### How it Works

1. **Mode Detection**: When a user sends a message, the main agent first analyzes the request to decide if it's `QUICK` or `ASYNC`.
   - `QUICK`: Simple questions answered from knowledge.
   - `ASYNC`: Tasks requiring tools (filesystem, code search, network) or likely to take >10 seconds.
2. **Immediate Confirmation**: If `ASYNC` is chosen, the agent returns a confirmation message immediately.
3. **Background Execution**: The task is offloaded to a secondary one-shot process using the CLI's standard prompt mode (`-p`). This mode is optimized for tool use and avoids streaming verbose reasoning to the chat.
4. **Context Synchronization**: Once the background task completes, the result is:
   - Sent directly to the user's chat.
   - Appended to the main agent's active ACP session context via a silent system prompt, ensuring the agent is "aware" of the completed work in future turns.
5. **Job Correlation**: Every background task is assigned a short reference (e.g., `job_abcd`) for tracking and correlation.

## Development Guidelines

- **Language:** TypeScript.
- **Package Manager:** npm.
- **Linter/Formatter:** Biome (`biome.json`).
- **Build:** `tsc` (TypeScript Compiler).
- **Testing:** (Add details if available).

## Operational Notes

- **Environment:** Requires `.env` configuration (see `.env.example`).
- **Logs:** Stored in `logs/` directory.
- **Persistence:** Data stored in `~/.clawless/` (databases, config, models).
