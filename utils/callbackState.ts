import fs from 'node:fs';
import { getErrorMessage } from './error.js';

type LogInfoFn = (message: string, details?: unknown) => void;

export function ensureBridgeHomeDirectory(bridgeHomePath: string) {
  fs.mkdirSync(bridgeHomePath, { recursive: true });
}

export function resolveChatId(value: unknown) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

  if (/^-?\d+$/.test(normalized)) {
    return normalized;
  }

  return normalized;
}

export function loadPersistedCallbackChatId(callbackStateFilePath: string, logInfo: LogInfoFn) {
  try {
    if (!fs.existsSync(callbackStateFilePath)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(callbackStateFilePath, 'utf8'));
    return resolveChatId(parsed?.chatId);
  } catch (error: any) {
    logInfo('Failed to load callback chat state', {
      callbackChatStateFilePath: callbackStateFilePath,
      error: getErrorMessage(error),
    });
    return null;
  }
}

export function persistCallbackChatId(
  callbackStateFilePath: string,
  chatId: string,
  ensureHomeDirectory: () => void,
  logInfo: LogInfoFn,
) {
  try {
    ensureHomeDirectory();
    fs.writeFileSync(
      callbackStateFilePath,
      `${JSON.stringify({ chatId: String(chatId), updatedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
  } catch (error: any) {
    logInfo('Failed to persist callback chat state', {
      callbackChatStateFilePath: callbackStateFilePath,
      error: getErrorMessage(error),
    });
  }
}
