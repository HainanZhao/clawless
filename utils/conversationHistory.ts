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

/**
 * Ensure conversation history file exists
 */
export function ensureConversationHistoryFile(filePath: string, logInfo: LogInfoFn) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify({ conversations: [] }, null, 2), 'utf8');
    logInfo('Created conversation history file', { filePath });
  }
}

/**
 * Append a conversation entry to the history file
 */
export function appendConversationEntry(
  config: ConversationHistoryConfig,
  entry: Omit<ConversationEntry, 'timestamp'>,
) {
  const { filePath, maxEntries, maxCharsPerEntry, logInfo } = config;

  try {
    ensureConversationHistoryFile(filePath, logInfo);

    // Read existing history
    let historyData: { conversations: ConversationEntry[] } = { conversations: [] };
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      historyData = JSON.parse(content);
      if (!Array.isArray(historyData.conversations)) {
        historyData.conversations = [];
      }
    } catch (parseError: any) {
      logInfo('Failed to parse conversation history; resetting to empty', {
        error: getErrorMessage(parseError),
      });
      historyData = { conversations: [] };
    }

    // Truncate long messages to prevent bloat
    const truncateText = (text: string) => {
      if (text.length <= maxCharsPerEntry) {
        return text;
      }
      return `${text.slice(0, maxCharsPerEntry)}... [truncated]`;
    };

    // Add new entry with timestamp
    const newEntry: ConversationEntry = {
      timestamp: new Date().toISOString(),
      chatId: entry.chatId,
      userMessage: truncateText(entry.userMessage),
      botResponse: truncateText(entry.botResponse),
      platform: entry.platform,
    };

    historyData.conversations.push(newEntry);

    // Keep only recent entries (FIFO rotation)
    if (historyData.conversations.length > maxEntries) {
      historyData.conversations = historyData.conversations.slice(-maxEntries);
    }

    // Write back to file
    fs.writeFileSync(filePath, JSON.stringify(historyData, null, 2), 'utf8');

    logInfo('Conversation entry appended', {
      chatId: entry.chatId,
      platform: entry.platform,
      totalEntries: historyData.conversations.length,
    });
  } catch (error: any) {
    logInfo('Failed to append conversation entry', {
      error: getErrorMessage(error),
      filePath,
    });
  }
}

/**
 * Load recent conversation entries from history file
 */
export function loadConversationHistory(config: ConversationHistoryConfig): ConversationEntry[] {
  const { filePath, logInfo } = config;

  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const historyData = JSON.parse(content);

    if (!Array.isArray(historyData.conversations)) {
      return [];
    }

    return historyData.conversations;
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
  const allHistory = loadConversationHistory(config);

  // Filter by chatId and take the most recent entries
  const chatHistory = allHistory.filter((entry) => entry.chatId === chatId).slice(-maxEntries);

  return chatHistory;
}

/**
 * Format conversation history for prompt injection
 */
export function formatConversationHistoryForPrompt(
  entries: ConversationEntry[],
  maxTotalChars: number,
): string {
  if (entries.length === 0) {
    return '(No recent conversation history)';
  }

  const lines: string[] = [];
  let totalChars = 0;

  // Add entries in chronological order
  for (const entry of entries) {
    const timestamp = new Date(entry.timestamp).toLocaleString();
    const entryText = [
      `[${timestamp}]`,
      `User: ${entry.userMessage}`,
      `Assistant: ${entry.botResponse}`,
      '',
    ].join('\n');

    // Stop if we exceed max chars
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
