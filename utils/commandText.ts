export function normalizeCommandText(text: unknown) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[!?.]+$/g, '');
}

export function isAbortCommand(text: unknown) {
  const normalized = normalizeCommandText(text);
  if (!normalized) {
    return false;
  }

  const commands = new Set(['abort', 'cancel', 'stop', '/abort', '/cancel', '/stop']);
  if (commands.has(normalized)) {
    return true;
  }

  const compact = normalized.replace(/\s+/g, ' ');
  return compact === 'please abort' || compact === 'please cancel' || compact === 'please stop';
}

export function normalizeOutgoingText(text: unknown) {
  return String(text || '').trim();
}
