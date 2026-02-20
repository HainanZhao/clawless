# Clawless Enhancement Report

## Investigation Findings

*   **Architecture & Purpose**: Clawless is a TypeScript-based bridge connecting Telegram and Slack to local CLI agents (Gemini, OpenCode, Claude Code) using the Agent Communication Protocol (ACP).
*   **Project Structure**: Well-organized modules:
    *   `core/`: Agent factory and callback server.
    *   `messaging/`: Platform integrations (Telegram, Slack).
    *   `scheduler/`: Cron-based tasks.
    *   `utils/`: Shared utilities.
*   **Current State**:
    *   **Monolithic Entry Point**: `index.ts` is ~400 lines, handling initialization, validation, and shutdown.
    *   **Configuration**: Relies on raw `process.env` access.
    *   **Testing**: No automated test suite found.
    *   **Logging**: Basic `console.log` wrapper.

## Proposed Enhancements

### 1. Refactor `index.ts` for Modularity
**Goal**: Break down the "god file" into dedicated bootstrappers.
**Benefit**: Easier testing and maintenance.

### 2. Validated Configuration (e.g., Zod)
**Goal**: Replace raw `process.env` with a strict schema validator.
**Benefit**: Fail-fast on missing config and type safety.

### 3. Comprehensive Test Suite
**Goal**: Introduce `vitest` or `jest`.
**Benefit**: Prevent regressions in complex logic like ACP runtime and queuing.

### 4. Structured Logging
**Goal**: Integrate `pino` or `winston`.
**Benefit**: Machine-readable logs, log levels (DEBUG/INFO/ERROR), and better production observability.

### 5. API Observability & Health Checks
**Goal**: Add OpenAPI specs and a `/health` endpoint.
**Benefit**: Easier debugging and integration monitoring.

### 6. Semantic Memory Optimization
**Goal**: Optimize `sql.js` usage or abstraction.
**Benefit**: Better performance for large conversation histories.

### 7. Standardized Error Handling
**Goal**: Centralized `ErrorHandler` and custom error classes.
**Benefit**: Consistent error reporting and debugging.
