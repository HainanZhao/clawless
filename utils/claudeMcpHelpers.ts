/**
 * Helper functions to read MCP server configuration from Claude Code settings.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Claude Code config locations to try
const CLAUDE_CONFIG_PATHS = [
  join(homedir(), '.claude', 'settings.json'),
  join(homedir(), '.config', 'claude', 'settings.json'),
  join(homedir(), '.claude', 'config.json'),
  join(homedir(), '.config', 'claude', 'config.json'),
];

export interface ClaudeMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
}

interface ClaudeSettings {
  mcpServers?: Record<string, ClaudeMcpServer>;
  [key: string]: unknown;
}

/**
 * Find and read Claude Code settings file
 */
function findClaudeSettings(): ClaudeSettings | null {
  for (const path of CLAUDE_CONFIG_PATHS) {
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
 * Read MCP server names from Claude Code settings.
 */
export function getClaudeMcpServerNames(): string[] {
  try {
    const settings = findClaudeSettings();
    if (!settings) {
      return [];
    }

    if (settings.mcpServers && typeof settings.mcpServers === 'object') {
      return Object.keys(settings.mcpServers);
    }

    return [];
  } catch (error) {
    console.error('Failed to read Claude MCP server names:', error);
    return [];
  }
}

/**
 * Read full MCP server configuration from Claude Code settings.
 * Returns array format compatible with ACP mcpServers parameter.
 */
export function getClaudeMcpServersForAcp(): unknown[] {
  try {
    const settings = findClaudeSettings();
    if (!settings || !settings.mcpServers || typeof settings.mcpServers !== 'object') {
      return [];
    }

    return Object.entries(settings.mcpServers)
      .map(([name, config]) => {
        const server = config as ClaudeMcpServer;

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
    console.error('Failed to read Claude MCP servers for ACP:', error);
    return [];
  }
}
