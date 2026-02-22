# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.4.7] - 2026-02-22


### Fixed

- Scheduler async jobs now correctly propagate and display the user-provided job reference ID, preventing mismatched identifiers in chat notifications.
- Corrected message truncation/splitting logic which previously could cut off code blocks or break Markdown; improved test coverage to prevent regressions.
- Various smaller bug fixes and code cleanups across messaging, semantic memory, and scheduler modules.

### Maintenance

- Updated and cleaned up test suite (removed obsolete tests, fixed failing cases, improved coverage).

---

## [0.4.6] - 2026-02-21

### Added

- **Markdown Image Support**: `getSafeMarkdownSplitPoint` now correctly handles markdown image syntax (`![alt](url)`) to prevent splitting inside images.
- **Comprehensive Test Suite**: Added 15+ new edge case tests for `messageTruncator.ts` covering markdown links, images, inline code, code blocks, escaped characters, and boundary conditions.

### Changed

- **Simplified Background Task Results**: Background task completion messages now show only the job ID reference instead of repeating the original request, making output more concise.
- **Background Task Prompt**: Added instruction to avoid narrating actions (e.g., "Let me check", "I will analyze") for cleaner output.

---

## [0.4.5] - 2026-02-21

### Added

- **Validated Configuration with Zod**: All configuration is now validated at startup using Zod schemas, providing clear error messages for missing or invalid environment variables.
- **Version upgrade check**: Added check for version upgrade.
- **Application Refactor**: Extracted initialization logic from `index.ts` into modular component managers (`ClawlessApp`, `AgentManager`, `CallbackServerManager`, `MessagingInitializer`, `SchedulerManager`) for improved maintainability.
- **Test Suite**: Added Vitest-based unit tests for core utilities and messaging (`config.test.ts`, `commandText.test.ts`, `liveMessageProcessor.test.ts`).

### Fixed

- Fixed mode detector logic for hybrid mode detection.
- Fixed configuration not being re-evaluated after loading the config file (early dotenv load order).
- Fixed environment variable interference between tests using isolated config evaluation.
- Fixed hybrid mode prompt formatting.

---

## [0.4.1] - 2026-02-20

### Fixed

- Fixed context issue for async agents where background task results were not properly synchronized with the main agent session.

---

## [0.4.0] - 2026-02-20

### Added

- **Asynchronous Hybrid Mode**: The bot now intelligently decides if a request needs a background task. Complex jobs (like scanning repos or running tests) now run in the background, providing an immediate confirmation so you aren't left waiting.
- **Smart Background Tasks**: Long-running tasks now provide a reference ID (e.g., `job_abcd`) and send results directly to the chat once completed.
- **Seamless Context Continuity**: When a background task finishes, the result is automatically synchronized with the main agent. This means the agent "remembers" the completed work in your next message.
- **Improved Message Reliability**: Better handling of message streaming and finalization for a smoother chat experience.

### Fixed

- Fixed an issue where the message queue could become stuck when handling multiple background tasks.
- Reduced "Thinking" log noise in the chat during background operations.
- Cleaned up system logs for better performance and readability.

---

## [0.3.10] - 2026-02-19

### Fixed

- Fixed message chunking debounce causing freezes - Now properly resets timer on each chunk using lodash debounce

### Changed

- Replaced hand-rolled debounce logic with lodash-es debounce for reliability

---

## [0.3.9] - 2026-02-18

### Added

- MCP server support in ACP mode for all agents (Gemini, OpenCode, Claude Code)
  - Reads MCP configs from agent settings files (`~/.gemini/settings.json`, `~/.opencode/settings.json`, `~/.claude/settings.json`)
  - Passes MCP server configs to ACP session for tool access

### Fixed

- MCP tools not accessible in ACP mode - Now passes MCP server configs to ACP session for all agents

---

## [0.3.8] - 2026-02-18

### Added

- Claude Code agent support - Add new CLI agent option using `claude-agent-acp`

### Fixed

- Missing CLI_AGENT error handling
- Removed Slack email check requirement
- Agent command selection now uses switch case for better readability

### Maintenance

- Updated repository links in package.json
- Updated README documentation
- Refactored validate() to base class and optimized string operations

---

## [0.3.4] - 2026-02-XX

### Added

- CLI agent abstraction layer with support for Gemini CLI and OpenCode

### Fixed

- Cleaned up legacy clawlessHome config

---

## [0.3.0] - 2026-02-XX

### Added

- Conversation memory layer for context-aware responses
- Conversation history tracking system (JSONL-based)
- Semantic recall using SQLite FTS

### Fixed

- Removed vector-based memory implementation
- Fixed model path naming
- Memory layer improvements

---

## [0.2.6] - 2026-01-XX

### Fixed

- Updated message format for final response

---

## [0.2.5] - 2026-01-XX

### Fixed

- Format markdown to Telegram markdown

---

## [0.2.4] - 2026-01-XX

### Fixed

- Version bump

---

## [0.2.0] - 2026-01-XX

### Added

- Slack messaging client with platform selection support

### Fixed

- MCP servers configuration
- Scheduler file handling on restart

---

## [0.1.0] - 2025-12-XX

### Added

- Initial release
- Telegram bot integration
- Gemini CLI ACP integration
