import fs from 'node:fs';
import path from 'node:path';
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

function toEntry(row: ConversationRow): ConversationEntry {
  return {
    timestamp: row.timestamp,
    chatId: row.chat_id,
    userMessage: row.user_message,
    botResponse: row.bot_response,
    platform: row.platform,
  };
}

function isConversationRow(value: unknown): value is ConversationRow {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const row = value as ConversationRow;
  return (
    typeof row.timestamp === 'string' &&
    typeof row.chat_id === 'string' &&
    typeof row.user_message === 'string' &&
    typeof row.bot_response === 'string' &&
    typeof row.platform === 'string'
  );
}

function readConversationRows(filePath: string, logInfo?: LogInfoFn): ConversationRow[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.trim()) {
      return [];
    }

    const rows: ConversationRow[] = [];
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) {
        continue;
      }

      try {
        const parsed = JSON.parse(line);
        if (isConversationRow(parsed)) {
          rows.push(parsed);
        }
      } catch (error: any) {
        if (logInfo) {
          logInfo('Skipping malformed conversation history line', {
            filePath,
            lineNumber: index + 1,
            error: getErrorMessage(error),
          });
        }
      }
    }

    return rows;
  } catch (error: any) {
    if (logInfo) {
      logInfo('Failed to read conversation history file', {
        filePath,
        error: getErrorMessage(error),
      });
    }
    return [];
  }
}

function writeConversationRows(filePath: string, rows: ConversationRow[]) {
  const content = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, content.length > 0 ? `${content}\n` : '', 'utf8');
}

/**
 * Ensure conversation history store exists
 */
export function ensureConversationHistoryFile(filePath: string, logInfo: LogInfoFn) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '', 'utf8');
      logInfo('Created conversation history file', { filePath });
    }
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
    ensureConversationHistoryFile(filePath, logInfo);

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

    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        timestamp: newEntry.timestamp,
        chat_id: newEntry.chatId,
        user_message: newEntry.userMessage,
        bot_response: newEntry.botResponse,
        platform: newEntry.platform,
      })}\n`,
      'utf8',
    );

    const rows = readConversationRows(filePath, logInfo);
    let finalRows = rows;
    if (maxEntries > 0 && rows.length > maxEntries) {
      finalRows = rows.slice(-maxEntries);
      writeConversationRows(filePath, finalRows);
    }

    logInfo('Conversation entry appended', {
      chatId: entry.chatId,
      platform: entry.platform,
      totalEntries: finalRows.length,
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
    const rows = readConversationRows(filePath, logInfo);
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
    const entries = loadConversationHistory(config);
    const limit = Math.max(1, maxEntries);
    return entries.filter((entry) => entry.chatId === chatId).slice(-limit);
  } catch (_error) {
    return [];
  }
}

/**
 * Get most recent conversation history entries globally (across chats)
 */
export function getRecentHistory(config: ConversationHistoryConfig, maxEntries = 10): ConversationEntry[] {
  try {
    const entries = loadConversationHistory(config);
    return entries.slice(-Math.max(1, maxEntries));
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
