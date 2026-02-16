export function parseAllowlistFromEnv(envValue: string, envKey: string): string[] {
  if (!envValue || envValue.trim() === '') {
    return [];
  }

  try {
    const parsed = JSON.parse(envValue);
    if (Array.isArray(parsed)) {
      return parsed.map((name) => String(name).trim().replace(/^@/, '')).filter(Boolean);
    }
  } catch {
    console.warn(
      `Warning: ${envKey} must be a valid JSON array (e.g., ["user1", "user2"])`,
    );
  }

  return [];
}

export function parseWhitelistFromEnv(envValue: string): string[] {
  return parseAllowlistFromEnv(envValue, 'TELEGRAM_WHITELIST');
}

export function isUserAuthorized(principal: string | undefined, whitelist: string[]): boolean {
  if (whitelist.length === 0 || !principal) {
    return false;
  }

  const normalizedPrincipal = principal.toLowerCase();
  return whitelist.some((entry) => entry.toLowerCase() === normalizedPrincipal);
}
