# Memory System Documentation

This document explains how Clawless memory works end-to-end: what is stored, where it is stored, how recap is selected, and how growth is bounded.

## Goals

- Preserve useful conversational context across runs
- Keep prompt context bounded and relevant
- Support semantic retrieval with local embeddings
- Stay local-first (no external memory service required)

## Memory Components

Clawless memory is split into three independent stores:

1. **Operator memory file**
   - Path default: `~/.clawless/MEMORY.md`
   - Purpose: persistent operator/user notes injected into prompt context

2. **Conversation history store**
   - Path default: `~/.clawless/conversation-history.jsonl`
   - Purpose: line-delimited JSON (JSONL) chat transcript entries used for recap

3. **Semantic embedding store**
   - Path default: `~/.clawless/conversation-semantic-memory.db`
   - Purpose: SQLite-backed per-entry embedding vectors for semantic recall ranking

## Runtime Flow

### 1) On startup

- Ensures bridge home directory exists (`AGENT_BRIDGE_HOME`, default `~/.clawless`)
- Ensures `MEMORY.md` exists
- If conversation history is enabled:
   - Ensures `conversation-history.jsonl` file exists
  - If semantic recall is enabled:
      - Ensures semantic store schema exists
    - Warms semantic index from recent history entries (bounded by semantic max entries)

### 2) On each inbound user message

Prompt context is built in this order:

1. Load `MEMORY.md` (bounded by `MEMORY_MAX_CHARS`)
2. Send prompt to Gemini CLI without automatic semantic recap injection
3. Agent can call local semantic recall API on demand when additional context is needed

### 2.1) On-demand semantic recall API

- Endpoint: `POST /api/memory/semantic-recall`
- Request body: `{"input":"current question","chatId":"optional","topK":3}`
- Response includes matching entries and a pre-formatted recap block
- This keeps normal prompts lean and fetches historical context only when required

### 3) After response is sent

- Append `{userMessage, botResponse, chatId, platform, timestamp}` to conversation history
- Enforce per-entry truncation and global FIFO rotation
- If semantic recall is enabled, index the appended entry into semantic store

## Persistence Model

- Conversation history uses **JSONL** text storage for easy inspection/debugging.
- Semantic storage uses **SQLite** for embeddings and vector search metadata.
- Semantic retrieval uses the **sqlite-vec extension** for SQLite KNN vector search.
- Retention is enforced by capped JSONL history entries and semantic row pruning.

## How Recap Selection Works

### Semantic path (on demand)

- Embeds requested input with `node-llama-cpp`
- Runs KNN search in `sqlite-vec`
- Filters by `chat_id`
- Returns `topK` entries in chronological order and recap format

## Bounded Growth and Scalability Controls

The system is intentionally capped in multiple places:

### Conversation history controls

- `CONVERSATION_HISTORY_MAX_ENTRIES` (default `100`): max stored entries (FIFO rotation)
- `CONVERSATION_HISTORY_MAX_CHARS_PER_ENTRY` (default `2000`): max chars for each user/assistant text
- `CONVERSATION_HISTORY_MAX_TOTAL_CHARS` (default `8000`): max chars injected into prompt recap

### Semantic store controls

- `CONVERSATION_SEMANTIC_MAX_ENTRIES` (default `1000`): max vectorized entries (FIFO rotation)
- `CONVERSATION_SEMANTIC_MAX_CHARS_PER_ENTRY` (default `4000`): max chars used to build embedding input
- `CONVERSATION_SEMANTIC_TIMEOUT_MS` (default `15000`): timeout for embedding init/query operations

### Recap scope controls

- `CONVERSATION_HISTORY_RECAP_TOP_K` (default `3`)

## Defaults and Override Model

Configuration precedence:

1. Environment variables
2. Config file values (`~/.clawless/config.json` by default)
3. Built-in defaults

Notable defaults:

- `CONVERSATION_HISTORY_ENABLED=true`
- `CONVERSATION_SEMANTIC_RECALL_ENABLED=true`

Semantic recall can be disabled at runtime by setting:

```bash
CONVERSATION_SEMANTIC_RECALL_ENABLED=false
```

## Operational Notes

- Conversation history is intentionally human-readable and easy to inspect with standard text tools.
- Semantic ranking now runs in SQLite via `sqlite-vec` (`MATCH` + `k`) and is then filtered by chat.
- For larger scale beyond single-node SQLite, migrate to a dedicated vector DB.

## Troubleshooting

1. **No semantic recap appears**
   - Verify `CONVERSATION_SEMANTIC_RECALL_ENABLED=true`
   - Check semantic model path and model availability
   - Check logs for semantic timeout/indexing failures

2. **History recap is always generic**
   - Increase `CONVERSATION_HISTORY_RECAP_TOP_K` if needed

3. **Memory looks stale**
   - Confirm append path is enabled (`CONVERSATION_HISTORY_ENABLED=true`)
   - Inspect `~/.clawless/conversation-history.jsonl` and semantic SQLite store files under `~/.clawless`

## Source Files

- `index.ts` (runtime orchestration + prompt building)
- `utils/memory.ts` (operator memory file handling)
- `utils/conversationHistory.ts` (history persistence + recap formatting)
- `utils/semanticConversationMemory.ts` (semantic vector store + retrieval)
