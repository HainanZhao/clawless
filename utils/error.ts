export function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error === null || error === undefined) {
    return fallback;
  }

  if (typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      const obj = error as Record<string, unknown>;
      const constructorName = typeof obj?.constructor?.name === 'string' ? obj.constructor.name : 'object';
      const keys = obj ? Object.keys(obj) : [];
      const detailsParts: string[] = [];
      if (constructorName) {
        detailsParts.push(`type=${constructorName}`);
      }
      if (keys.length > 0) {
        detailsParts.push(`keys=${keys.join(', ')}`);
      }
      const details = detailsParts.length > 0 ? ` (${detailsParts.join(', ')})` : '';
      return `Unserializable error object${details}`;
    }
  }

  return String(error);
}

export function logInfo(message: string, details?: unknown) {
  const timestamp = new Date().toISOString();
  if (details !== undefined) {
    console.log(`[${timestamp}] INFO: ${message}`, details);
    return;
  }

  console.log(`[${timestamp}] INFO: ${message}`);
}

export function logError(message: string, details?: unknown) {
  const timestamp = new Date().toISOString();
  if (details !== undefined) {
    console.error(`[${timestamp}] ERROR: ${message}`, details);
    return;
  }

  console.error(`[${timestamp}] ERROR: ${message}`);
}
