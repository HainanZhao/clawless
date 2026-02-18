/**
 * Helper functions to read MCP server configuration from OpenCode settings.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// OpenCode config locations to try
const OPENCODE_CONFIG_PATHS = [
  join(homedir(), '.opencode', 'settings.json'),
  join(homedir(), '.config', 'opencode', 'settings.json'),
];

export interface OpenCodeMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
}

interface OpenCodeSettings {
  mcpServers?: Record<string, OpenCodeMcpServer>;
  [key: string]: unknown;
}

/**
 * Find and read OpenCode settings file
 */
function findOpenCodeSettings(): OpenCodeSettings | null {
  for (const path of OPENCODE_CONFIG_PATHS) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8');
        return JSON.parse(content);
      } catch {
        // Continue to next path
      }
    }
  }
  return null;
}

/**
 * Read MCP server names from OpenCode settings.
 */
export function getOpenCodeMcpServerNames(): string[] {
  try {
    const settings = findOpenCodeSettings();
    if (!settings) {
      return [];
    }

    if (settings.mcpServers && typeof settings.mcpServers === 'object') {
      return Object.keys(settings.mcpServers);
    }

    return [];
  } catch (error) {
    console.error('Failed to read OpenCode MCP server names:', error);
    return [];
  }
}

/**
 * Read full MCP server configuration from OpenCode settings.
 * Returns array format compatible with ACP mcpServers parameter.
 */
export function getOpenCodeMcpServersForAcp(): unknown[] {
  try {
    const settings = findOpenCodeSettings();
    if (!settings || !settings.mcpServers || typeof settings.mcpServers !== 'object') {
      return [];
    }

    return Object.entries(settings.mcpServers)
      .map(([name, config]) => {
        const server = config as OpenCodeMcpServer;

        if (server.command) {
          return {
            name,
            command: server.command,
            args: server.args || [],
            env: server.env ? Object.entries(server.env).map(([key, value]) => ({ name: key, value })) : [],
          };
        }

        if (server.url) {
          return {
            name,
            type: server.type || 'sse',
            url: server.url,
          };
        }

        return null;
      })
      .filter(Boolean);
  } catch (error) {
    console.error('Failed to read OpenCode MCP servers for ACP:', error);
    return [];
  }
}
