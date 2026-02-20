export type McpServersSource = 'default-empty' | 'env-override';

export type McpServersResult = {
  source: McpServersSource;
  mcpServers: unknown[];
};

export type McpServersLogger = (message: string, details?: unknown) => void;
export type McpServersErrorFormatter = (error: unknown, fallbackMessage?: string) => string;

function normalizeEnvArray(envValue: unknown) {
  if (Array.isArray(envValue)) {
    return envValue
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => {
        const candidate = entry as { name?: unknown; value?: unknown };
        return {
          name: String(candidate.name ?? ''),
          value: String(candidate.value ?? ''),
        };
      })
      .filter((entry) => entry.name.length > 0);
  }

  if (envValue && typeof envValue === 'object') {
    return Object.entries(envValue as Record<string, unknown>).map(([name, value]) => ({
      name,
      value: String(value ?? ''),
    }));
  }

  return [];
}

function normalizeSingleMcpServer(name: string, serverConfig: unknown) {
  if (!serverConfig || typeof serverConfig !== 'object' || Array.isArray(serverConfig)) {
    return null;
  }

  const candidate = serverConfig as Record<string, unknown>;
  const hasCommand = typeof candidate.command === 'string' && candidate.command.length > 0;
  const hasUrl = typeof candidate.url === 'string' && candidate.url.length > 0;

  if (hasCommand) {
    return {
      name,
      command: String(candidate.command),
      args: Array.isArray(candidate.args) ? candidate.args.map((arg) => String(arg)) : [],
      env: normalizeEnvArray(candidate.env),
    };
  }

  if (hasUrl) {
    const type = candidate.type === 'sse' ? 'sse' : 'http';
    const headers = Array.isArray(candidate.headers)
      ? candidate.headers
          .filter((header) => header && typeof header === 'object')
          .map((header) => {
            const typedHeader = header as { name?: unknown; value?: unknown };
            return {
              name: String(typedHeader.name ?? ''),
              value: String(typedHeader.value ?? ''),
            };
          })
          .filter((header) => header.name.length > 0)
      : [];

    return {
      type,
      name,
      url: String(candidate.url),
      headers,
    };
  }

  return null;
}

function normalizeMcpServers(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => normalizeSingleMcpServer(`server_${index + 1}`, entry))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([name, serverConfig]) => normalizeSingleMcpServer(name, serverConfig))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  }

  return [];
}

export function getMcpServersForSession(options: {
  acpMcpServersJson?: string;
  logInfo: McpServersLogger;
  getErrorMessage: McpServersErrorFormatter;
  invalidEnvMessage: string;
  logDetails?: Record<string, unknown>;
}): McpServersResult {
  const { acpMcpServersJson: raw, logInfo, getErrorMessage, invalidEnvMessage, logDetails } = options;
  if (!raw) {
    return {
      source: 'default-empty',
      mcpServers: [],
    };
  }

  try {
    return {
      source: 'env-override',
      mcpServers: normalizeMcpServers(JSON.parse(raw)),
    };
  } catch (error) {
    logInfo(invalidEnvMessage, {
      error: getErrorMessage(error),
      ...logDetails,
    });

    return {
      source: 'default-empty',
      mcpServers: [],
    };
  }
}
