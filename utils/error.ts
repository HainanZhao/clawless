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
  return String(error);
}

export function logInfo(message: string, details?: unknown) {
  const timestamp = new Date().toISOString();
  if (details !== undefined) {
    console.log(`[${timestamp}] ${message}`, details);
    return;
  }

  console.log(`[${timestamp}] ${message}`);
}
