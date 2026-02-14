export function parseWhitelistFromEnv(envValue: string): string[] {
  if (!envValue || envValue.trim() === '') {
    return [];
  }

  try {
    const parsed = JSON.parse(envValue);
    if (Array.isArray(parsed)) {
      return parsed
        .map((name) => String(name).trim().replace(/^@/, ''))
        .filter(Boolean);
    }
  } catch {
    console.warn('Warning: TELEGRAM_WHITELIST must be a valid JSON array of usernames (e.g., ["user1", "user2"])');
  }

  return [];
}

export function isUserAuthorized(username: string | undefined, whitelist: string[]): boolean {
  if (whitelist.length === 0 || !username) {
    return false;
  }

  const normalizedUsername = username.toLowerCase();
  return whitelist.some((entry) => entry.toLowerCase() === normalizedUsername);
}
