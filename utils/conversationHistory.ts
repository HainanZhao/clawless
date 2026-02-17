import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getErrorMessage } from './error.js';

type LogInfoFn = (message: string, details?: unknown) => void;

export interface ConversationEntry {
  timestamp: string;
  chatId: string;
  userMessage: string;
  botResponse: string;
  platform: string;
}

export interface ConversationHistoryConfig {
  filePath: string;
  maxEntries: number;
  maxCharsPerEntry: number;
  maxTotalChars: number;
  logInfo: LogInfoFn;
}

export interface ConversationRecapOptions {
  topK: number;
}

type ConversationRow = {
  timestamp: string;
  chat_id: string;
  user_message: string;
  bot_response: string;
  platform: string;
};

const dbCache = new Map<string, Database.Database>();

function toEntry(row: ConversationRow): ConversationEntry {
  return {
    timestamp: row.timestamp,
    chatId: row.chat_id,
    userMessage: row.user_message,
    botResponse: row.bot_response,
    platform: row.platform,
  };
}

function getDatabase(filePath: string): Database.Database {
  let db = dbCache.get(filePath);
  if (db) {
    return db;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_history (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      user_message TEXT NOT NULL,
      bot_response TEXT NOT NULL,
      platform TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_history_chat_seq
      ON conversation_history(chat_id, seq);
  `);

  dbCache.set(filePath, db);
  return db;
}

/**
 * Ensure conversation history store exists
 */
export function ensureConversationHistoryFile(filePath: string, logInfo: LogInfoFn) {
  try {
    getDatabase(filePath);
  } catch (error: any) {
    logInfo('Failed to initialize conversation history store', {
      filePath,
      error: getErrorMessage(error),
    });
    throw error;
  }
}

/**
 * Append a conversation entry to the history store
 */
export function appendConversationEntry(
  config: ConversationHistoryConfig,
  entry: Omit<ConversationEntry, 'timestamp'>,
): ConversationEntry | null {
  const { filePath, maxEntries, maxCharsPerEntry, logInfo } = config;

  try {
    const db = getDatabase(filePath);

    const truncateText = (text: string) => {
      if (text.length <= maxCharsPerEntry) {
        return text;
      }
      return `${text.slice(0, maxCharsPerEntry)}... [truncated]`;
    };

    const newEntry: ConversationEntry = {
      timestamp: new Date().toISOString(),
      chatId: entry.chatId,
      userMessage: truncateText(entry.userMessage),
      botResponse: truncateText(entry.botResponse),
      platform: entry.platform,
    };

    const insertStmt = db.prepare(`
      INSERT INTO conversation_history (timestamp, chat_id, user_message, bot_response, platform)
      VALUES (@timestamp, @chat_id, @user_message, @bot_response, @platform)
    `);

    const pruneStmt = db.prepare(`
      DELETE FROM conversation_history
      WHERE seq NOT IN (
        SELECT seq FROM conversation_history ORDER BY seq DESC LIMIT ?
      )
    `);

    const countStmt = db.prepare('SELECT COUNT(*) AS total FROM conversation_history');

    const transaction = db.transaction(() => {
      insertStmt.run({
        timestamp: newEntry.timestamp,
        chat_id: newEntry.chatId,
        user_message: newEntry.userMessage,
        bot_response: newEntry.botResponse,
        platform: newEntry.platform,
      });

      if (maxEntries > 0) {
        pruneStmt.run(maxEntries);
      }
    });

    transaction();

    const countRow = countStmt.get() as { total: number };
    logInfo('Conversation entry appended', {
      chatId: entry.chatId,
      platform: entry.platform,
      totalEntries: countRow.total,
    });

    return newEntry;
  } catch (error: any) {
    logInfo('Failed to append conversation entry', {
      error: getErrorMessage(error),
      filePath,
    });

    return null;
  }
}

/**
 * Load conversation entries from history store
 */
export function loadConversationHistory(config: ConversationHistoryConfig): ConversationEntry[] {
  const { filePath, logInfo } = config;

  try {
    const db = getDatabase(filePath);
    const rows = db
      .prepare(
        'SELECT timestamp, chat_id, user_message, bot_response, platform FROM conversation_history ORDER BY seq ASC',
      )
      .all() as ConversationRow[];

    return rows.map(toEntry);
  } catch (error: any) {
    logInfo('Failed to load conversation history', {
      error: getErrorMessage(error),
      filePath,
    });
    return [];
  }
}

/**
 * Get relevant conversation history for a specific chat
 */
export function getRelevantHistory(
  config: ConversationHistoryConfig,
  chatId: string,
  maxEntries = 10,
): ConversationEntry[] {
  try {
    const db = getDatabase(config.filePath);
    const rows = db
      .prepare(
        `
          SELECT timestamp, chat_id, user_message, bot_response, platform
          FROM conversation_history
          WHERE chat_id = ?
          ORDER BY seq DESC
          LIMIT ?
        `,
      )
      .all(chatId, Math.max(1, maxEntries)) as ConversationRow[];

    rows.reverse();
    return rows.map(toEntry);
  } catch (_error) {
    return [];
  }
}

/**
 * Get most recent conversation history entries globally (across chats)
 */
export function getRecentHistory(config: ConversationHistoryConfig, maxEntries = 10): ConversationEntry[] {
  try {
    const db = getDatabase(config.filePath);
    const rows = db
      .prepare(
        `
          SELECT timestamp, chat_id, user_message, bot_response, platform
          FROM conversation_history
          ORDER BY seq DESC
          LIMIT ?
        `,
      )
      .all(Math.max(1, maxEntries)) as ConversationRow[];

    rows.reverse();
    return rows.map(toEntry);
  } catch (_error) {
    return [];
  }
}

/**
 * Format conversation history for prompt injection
 */
export function formatConversationHistoryForPrompt(entries: ConversationEntry[], maxTotalChars: number): string {
  if (entries.length === 0) {
    return '(No recent conversation history)';
  }

  const lines: string[] = [];
  let totalChars = 0;

  for (const entry of entries) {
    const timestamp = new Date(entry.timestamp).toLocaleString();
    const entryText = [`[${timestamp}]`, `User: ${entry.userMessage}`, `Assistant: ${entry.botResponse}`, ''].join(
      '\n',
    );

    if (totalChars + entryText.length > maxTotalChars) {
      break;
    }

    lines.push(entryText);
    totalChars += entryText.length;
  }

  return lines.join('\n');
}

/**
 * Build prompt with both conversation history and memory context
 */
export function buildConversationContext(
  config: ConversationHistoryConfig,
  chatId: string,
  maxRecentEntries: number,
): string {
  const relevantHistory = getRelevantHistory(config, chatId, maxRecentEntries);
  return formatConversationHistoryForPrompt(relevantHistory, config.maxTotalChars);
}

/**
 * Build a compact recap from recent conversation history.
 */
export function buildSmartConversationContext(
  config: ConversationHistoryConfig,
  _chatId: string,
  _userPrompt: string,
  options: ConversationRecapOptions,
): string {
  const recentHistory = getRecentHistory(config, options.topK);
  const recapText = formatConversationHistoryForPrompt(recentHistory, config.maxTotalChars);
  if (!recapText || recapText === '(No recent conversation history)') {
    return '';
  }

  return recapText;
}
