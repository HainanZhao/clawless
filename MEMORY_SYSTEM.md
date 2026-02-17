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
   - Path default: `~/.clawless/conversation-history.db`
   - Purpose: SQLite-backed chat transcript entries used for recap

3. **Semantic embedding store**
   - Path default: `~/.clawless/conversation-semantic-memory.db`
   - Purpose: SQLite-backed per-entry embedding vectors for semantic recall ranking

## Runtime Flow

### 1) On startup

- Ensures bridge home directory exists (`AGENT_BRIDGE_HOME`, default `~/.clawless`)
- Ensures `MEMORY.md` exists
- If conversation history is enabled:
   - Ensures `conversation-history.db` schema exists
  - If semantic recall is enabled:
      - Ensures semantic store schema exists
    - Warms semantic index from recent history entries (bounded by semantic max entries)

### 2) On each inbound user message

Prompt context is built in this order:

1. Load `MEMORY.md` (bounded by `MEMORY_MAX_CHARS`)
2. If conversation history is enabled and a chat id is available:
   - Try semantic retrieval first (top K by vector similarity)
3. Inject resulting conversation recap (bounded by total prompt char budget)
4. If semantic retrieval is unavailable/empty, inject recent conversation history only once at startup context

### 3) After response is sent

- Append `{userMessage, botResponse, chatId, platform, timestamp}` to conversation history
- Enforce per-entry truncation and global FIFO rotation
- If semantic recall is enabled, index the appended entry into semantic store

## Persistence Model (Scalable)

- Both history and semantic layers now use **SQLite** as the persistence engine.
- Writes are incremental row inserts/updates instead of full-file rewrites.
- Semantic retrieval uses the **sqlite-vec extension** for SQLite KNN vector search.
- Retention is enforced by deleting older rows beyond configured caps.

## How Recap Selection Works

### Semantic path (primary when enabled)

- Embeds current user prompt with `node-llama-cpp`
- Compares against stored entry embeddings for the same chat
- Picks `topK` entries by cosine similarity
- Returns entries in chronological order for prompt formatting

### TF-IDF fallback path

- Removed for simplicity.
- Fallback behavior now uses most recent `topK` history entries (no TF-IDF ranking), injected once at startup context.

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

- `CONVERSATION_HISTORY_RECAP_TOP_K` (default `4`)
- `CONVERSATION_HISTORY_MAX_RECENT_ENTRIES` (legacy fallback when top-k is unset)

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

- SQLite significantly reduces write amplification versus JSON rewrite approaches.
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
   - Inspect the SQLite stores under `~/.clawless`

## Source Files

- `index.ts` (runtime orchestration + prompt building)
- `utils/memory.ts` (operator memory file handling)
- `utils/conversationHistory.ts` (history persistence + TF-IDF fallback)
- `utils/semanticConversationMemory.ts` (semantic vector store + retrieval)
