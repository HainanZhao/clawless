import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { getErrorMessage } from './error.js';
import type { ConversationEntry } from './conversationHistory.js';

type LogInfoFn = (message: string, details?: unknown) => void;

export interface SemanticConversationMemoryConfig {
  enabled: boolean;
  storePath: string;
  modelPath: string;
  maxEntries: number;
  maxCharsPerEntry: number;
  timeoutMs: number;
}

type SemanticRow = {
  timestamp: string;
  chat_id: string;
  user_message: string;
  bot_response: string;
  platform: string;
};

type SemanticEntryForTriplet = {
  seq: number;
  user_message: string;
  bot_response: string;
};

const VECTOR_TABLE_NAME = 'semantic_memory_vectors';
const META_TABLE_NAME = 'semantic_memory_meta';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function normalizeVector(vector: number[]): number[] {
  if (vector.length === 0) {
    return vector;
  }

  let sumSquares = 0;
  for (const value of vector) {
    sumSquares += value * value;
  }

  if (sumSquares <= 0) {
    return vector;
  }

  const norm = Math.sqrt(sumSquares);
  return vector.map((value) => Number((value / norm).toFixed(8)));
}

function toEntryId(entry: ConversationEntry): string {
  return `${entry.timestamp}|${entry.chatId}|${entry.platform}`;
}

function truncateForEmbedding(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(0, maxChars);
}

function isMissingNodeLlamaCppError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return (
    message.includes("Cannot find package 'node-llama-cpp'") || message.includes("Cannot find module 'node-llama-cpp'")
  );
}

function isMissingSqliteVecError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return message.includes("Cannot find module 'sqlite-vec'") || message.includes("Cannot find package 'sqlite-vec'");
}

function toConversationEntry(row: SemanticRow): ConversationEntry {
  return {
    timestamp: row.timestamp,
    chatId: row.chat_id,
    userMessage: row.user_message,
    botResponse: row.bot_response,
    platform: row.platform,
  };
}

export class SemanticConversationMemory {
  private readonly config: SemanticConversationMemoryConfig;
  private readonly logInfo: LogInfoFn;
  private embeddingContextPromise: Promise<any | null> | null = null;
  private isInitializationLogged = false;
  private runtimeDisabled = false;
  private runtimeDisableLogged = false;
  private db: Database.Database | null = null;
  private vectorExtensionLoaded = false;

  constructor(config: SemanticConversationMemoryConfig, logInfo: LogInfoFn) {
    this.config = config;
    this.logInfo = logInfo;
  }

  get isEnabled() {
    return this.config.enabled && !this.runtimeDisabled;
  }

  private disableRuntime(reason: string, error?: unknown, action?: string) {
    this.runtimeDisabled = true;
    this.embeddingContextPromise = null;

    if (this.runtimeDisableLogged) {
      return;
    }

    this.runtimeDisableLogged = true;
    this.logInfo('Semantic memory disabled at runtime', {
      reason,
      error: error ? getErrorMessage(error) : undefined,
      action:
        action ||
        'Verify node-llama-cpp/sqlite-vec dependencies and restart, or set CONVERSATION_SEMANTIC_RECALL_ENABLED=false.',
    });
  }

  private ensureVectorExtensionLoaded(db: Database.Database) {
    if (this.vectorExtensionLoaded) {
      return;
    }

    try {
      const require = createRequire(import.meta.url);
      const sqliteVec = require('sqlite-vec') as { load?: (targetDb: Database.Database) => void };
      if (typeof sqliteVec?.load !== 'function') {
        throw new Error('sqlite-vec does not expose load(db)');
      }

      sqliteVec.load(db);
      this.vectorExtensionLoaded = true;
      this.logInfo('sqlite-vec extension loaded', { storePath: this.config.storePath });
    } catch (error: any) {
      const reason = isMissingSqliteVecError(error)
        ? 'missing sqlite-vec dependency'
        : 'failed to load sqlite-vec extension';
      this.disableRuntime(
        reason,
        error,
        "Install 'sqlite-vec' and restart, or set CONVERSATION_SEMANTIC_RECALL_ENABLED=false.",
      );
      throw error;
    }
  }

  private getDatabase(): Database.Database {
    if (this.db) {
      return this.db;
    }

    try {
      fs.mkdirSync(path.dirname(this.config.storePath), { recursive: true });
      const db = new Database(this.config.storePath);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('temp_store = MEMORY');

      this.ensureVectorExtensionLoaded(db);

      db.exec(`
        CREATE TABLE IF NOT EXISTS semantic_memory_entries (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          entry_id TEXT NOT NULL UNIQUE,
          timestamp TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          user_message TEXT NOT NULL,
          bot_response TEXT NOT NULL,
          platform TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ${META_TABLE_NAME} (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_semantic_memory_chat_seq
          ON semantic_memory_entries(chat_id, seq);
      `);

      this.db = db;
      return db;
    } catch (error: any) {
      this.disableRuntime('failed to initialize semantic memory database', error);
      throw error;
    }
  }

  private getVectorDimension(db: Database.Database): number | null {
    const row = db.prepare(`SELECT value FROM ${META_TABLE_NAME} WHERE key = 'vector_dim'`).get() as
      | { value?: string }
      | undefined;

    if (!row?.value) {
      return null;
    }

    const dimension = Number.parseInt(row.value, 10);
    return Number.isFinite(dimension) && dimension > 0 ? dimension : null;
  }

  private ensureVectorTableForDimension(db: Database.Database, dimension: number) {
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error(`Invalid embedding dimension: ${dimension}`);
    }

    const existingDimension = this.getVectorDimension(db);
    if (existingDimension && existingDimension !== dimension) {
      throw new Error(
        `Embedding dimension mismatch. Existing: ${existingDimension}, current: ${dimension}. ` +
          'Use a new CONVERSATION_SEMANTIC_STORE_PATH when switching embedding models.',
      );
    }

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE_NAME}
      USING vec0(embedding float[${dimension}]);
    `);

    if (!existingDimension) {
      db.prepare(`INSERT OR REPLACE INTO ${META_TABLE_NAME} (key, value) VALUES ('vector_dim', ?)`).run(
        String(dimension),
      );
    }
  }

  ensureStoreFile() {
    if (!this.isEnabled) {
      return;
    }

    try {
      this.getDatabase();
    } catch {
      // Runtime disable and logging handled in getDatabase/disableRuntime
    }
  }

  private async getEmbeddingContext() {
    if (!this.isEnabled) {
      return null;
    }

    if (this.embeddingContextPromise) {
      return this.embeddingContextPromise;
    }

    this.embeddingContextPromise = withTimeout(
      (async () => {
        const moduleName = 'node-llama-cpp';
        const llamaModule: any = await import(moduleName);
        const getLlama = llamaModule.getLlama ?? llamaModule.default?.getLlama;
        const resolveModelFile = llamaModule.resolveModelFile ?? llamaModule.default?.resolveModelFile;

        if (typeof getLlama !== 'function') {
          throw new Error('node-llama-cpp does not expose getLlama()');
        }

        if (typeof resolveModelFile !== 'function') {
          throw new Error('node-llama-cpp does not expose resolveModelFile()');
        }

        const llama = await getLlama({ logLevel: 'error' });
        const modelDirectory = path.join(path.dirname(this.config.storePath), 'models');
        const resolvedModelPath = await resolveModelFile(this.config.modelPath, modelDirectory);
        const model = await llama.loadModel({
          modelPath: resolvedModelPath,
        });
        const embeddingContext = await model.createEmbeddingContext();

        if (!this.isInitializationLogged) {
          this.logInfo('Semantic memory embedding context initialized', {
            configuredModelPath: this.config.modelPath,
            resolvedModelPath,
            modelDirectory,
            storePath: this.config.storePath,
          });
          this.isInitializationLogged = true;
        }

        return embeddingContext;
      })(),
      this.config.timeoutMs,
      'Semantic embedding context initialization',
    ).catch((error) => {
      this.embeddingContextPromise = null;

      if (isMissingNodeLlamaCppError(error)) {
        this.disableRuntime(
          'missing node-llama-cpp dependency',
          error,
          "Install 'node-llama-cpp' and restart, or set CONVERSATION_SEMANTIC_RECALL_ENABLED=false.",
        );
        return null;
      }

      throw error;
    });

    return this.embeddingContextPromise;
  }

  private async getEmbeddingVector(text: string): Promise<number[]> {
    const embeddingContext = await this.getEmbeddingContext();
    if (!embeddingContext) {
      return [];
    }

    const result = await withTimeout(
      embeddingContext.getEmbeddingFor(text),
      this.config.timeoutMs,
      'Semantic embedding generation',
    );

    const resultAny: any = result;
    const rawVector =
      (Array.isArray(resultAny) ? resultAny : null) ??
      (Array.isArray(resultAny?.vector) ? resultAny.vector : null) ??
      (Array.isArray(resultAny?.embedding) ? resultAny.embedding : null) ??
      (Array.isArray(resultAny?.values) ? resultAny.values : null);

    if (!rawVector) {
      return [];
    }

    const numericVector = rawVector
      .map((value: unknown) => (typeof value === 'number' ? value : Number(value)))
      .filter((value: number) => Number.isFinite(value));

    return normalizeVector(numericVector);
  }

  private buildEmbeddingInput(
    entry: Pick<ConversationEntry, 'userMessage' | 'botResponse'>,
    followUpUserMessage?: string,
  ): string {
    const lines = [`User: ${entry.userMessage}`, `Assistant: ${entry.botResponse}`];
    if (followUpUserMessage && followUpUserMessage.trim().length > 0) {
      lines.push(`Follow-up User: ${followUpUserMessage}`);
    }

    return truncateForEmbedding(lines.join('\n'), this.config.maxCharsPerEntry);
  }

  async indexEntry(entry: ConversationEntry): Promise<void> {
    if (!this.isEnabled) {
      return;
    }

    try {
      const embeddingInput = this.buildEmbeddingInput(entry);
      const vector = await this.getEmbeddingVector(embeddingInput);
      if (vector.length === 0) {
        return;
      }

      const db = this.getDatabase();
      this.ensureVectorTableForDimension(db, vector.length);

      const entryId = toEntryId(entry);

      const insertEntryStmt = db.prepare(`
        INSERT OR IGNORE INTO semantic_memory_entries
        (entry_id, timestamp, chat_id, user_message, bot_response, platform)
        VALUES (@entry_id, @timestamp, @chat_id, @user_message, @bot_response, @platform)
      `);
      const findSeqStmt = db.prepare('SELECT seq FROM semantic_memory_entries WHERE entry_id = ?');
      const deleteVectorStmt = db.prepare(`DELETE FROM ${VECTOR_TABLE_NAME} WHERE rowid = CAST(? AS INTEGER)`);
      const insertVectorStmt = db.prepare(
        `INSERT INTO ${VECTOR_TABLE_NAME}(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)`,
      );
      const findPreviousEntryStmt = db.prepare(`
        SELECT seq, user_message, bot_response
        FROM semantic_memory_entries
        WHERE chat_id = ?
          AND seq < ?
        ORDER BY seq DESC
        LIMIT 1
      `);
      const pruneEntryStmt = db.prepare(`
        DELETE FROM semantic_memory_entries
        WHERE seq NOT IN (
          SELECT seq FROM semantic_memory_entries ORDER BY seq DESC LIMIT ?
        )
      `);
      const pruneVectorStmt = db.prepare(`
        DELETE FROM ${VECTOR_TABLE_NAME}
        WHERE rowid NOT IN (SELECT seq FROM semantic_memory_entries)
      `);

      let currentRowId: number | null = null;

      const transaction = db.transaction(() => {
        const insertResult = insertEntryStmt.run({
          entry_id: entryId,
          timestamp: entry.timestamp,
          chat_id: entry.chatId,
          user_message: entry.userMessage,
          bot_response: entry.botResponse,
          platform: entry.platform,
        });

        const seqRow = findSeqStmt.get(entryId) as { seq: number } | undefined;
        const parsedRowId = Number(seqRow?.seq);
        const rowId = Number.isInteger(parsedRowId) && parsedRowId > 0 ? parsedRowId : null;
        currentRowId = rowId;

        if (insertResult.changes > 0 && rowId !== null) {
          deleteVectorStmt.run(rowId);
          insertVectorStmt.run(rowId, JSON.stringify(vector));
        } else if (insertResult.changes > 0 && rowId === null) {
          this.logInfo('Skipped semantic vector insert due to invalid rowid', {
            entryId,
            rawSeq: seqRow?.seq,
          });
        }

        if (this.config.maxEntries > 0) {
          pruneEntryStmt.run(this.config.maxEntries);
          pruneVectorStmt.run();
        }
      });

      transaction();

      if (currentRowId !== null) {
        const previousEntry = findPreviousEntryStmt.get(entry.chatId, currentRowId) as
          | SemanticEntryForTriplet
          | undefined;

        if (previousEntry) {
          const previousEmbeddingInput = this.buildEmbeddingInput(
            {
              userMessage: previousEntry.user_message,
              botResponse: previousEntry.bot_response,
            },
            entry.userMessage,
          );
          const previousVector = await this.getEmbeddingVector(previousEmbeddingInput);

          if (previousVector.length > 0) {
            this.ensureVectorTableForDimension(db, previousVector.length);
            deleteVectorStmt.run(previousEntry.seq);
            insertVectorStmt.run(previousEntry.seq, JSON.stringify(previousVector));
          }
        }
      }
    } catch (error: any) {
      this.logInfo('Failed to index semantic conversation entry', {
        error: getErrorMessage(error),
      });
    }
  }

  async getRelevantEntries(chatId: string, userPrompt: string, topK: number): Promise<ConversationEntry[]> {
    if (!this.isEnabled || topK <= 0) {
      return [];
    }

    try {
      const queryVector = await this.getEmbeddingVector(truncateForEmbedding(userPrompt, this.config.maxCharsPerEntry));
      if (queryVector.length === 0) {
        return [];
      }

      const db = this.getDatabase();
      const dimension = this.getVectorDimension(db);
      if (!dimension || queryVector.length !== dimension) {
        return [];
      }

      const searchK = Math.max(topK, Math.min(this.config.maxEntries, Math.max(topK * 8, 64)));

      const rows = db
        .prepare(
          `
            SELECT e.timestamp, e.chat_id, e.user_message, e.bot_response, e.platform
            FROM (
              SELECT rowid, distance
              FROM ${VECTOR_TABLE_NAME}
              WHERE embedding MATCH ?
                AND k = ?
            ) v
            JOIN semantic_memory_entries e ON e.seq = v.rowid
            WHERE e.chat_id = ?
            ORDER BY v.distance ASC, e.seq DESC
            LIMIT ?
          `,
        )
        .all(JSON.stringify(queryVector), searchK, chatId, topK) as SemanticRow[];

      if (rows.length === 0) {
        return [];
      }

      return rows.map(toConversationEntry).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    } catch (error: any) {
      this.logInfo('Failed semantic conversation recall', {
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  async warmFromHistory(entries: ConversationEntry[]): Promise<void> {
    if (!this.isEnabled || entries.length === 0) {
      return;
    }

    const recentEntries = entries.slice(-this.config.maxEntries);
    for (const entry of recentEntries) {
      await this.indexEntry(entry);
    }
  }
}
