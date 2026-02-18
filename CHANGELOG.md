# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
