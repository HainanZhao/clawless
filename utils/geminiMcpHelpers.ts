/**
 * Helper functions to read MCP server configuration from Gemini CLI settings.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const GEMINI_SETTINGS_PATH = join(homedir(), '.gemini', 'settings.json');

export interface GeminiMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  headers?: Array<{ name: string; value: string }>;
}

interface GeminiSettings {
  mcpServers?: Record<string, GeminiMcpServer>;
  [key: string]: unknown;
}

/**
 * Read MCP server names from Gemini CLI settings file.
 * This allows ACP mode to use the same MCP servers configured in normal Gemini CLI.
 */
export function getGeminiMcpServerNames(): string[] {
  try {
    if (!existsSync(GEMINI_SETTINGS_PATH)) {
      return [];
    }

    const content = readFileSync(GEMINI_SETTINGS_PATH, 'utf-8');
    const settings: GeminiSettings = JSON.parse(content);

    if (settings.mcpServers && typeof settings.mcpServers === 'object') {
      const names = Object.keys(settings.mcpServers);
      return names;
    }

    return [];
  } catch (error) {
    console.error('Failed to read Gemini MCP server names:', error);
    return [];
  }
}

/**
 * Read full MCP server configuration from Gemini CLI settings file.
 * Returns array format compatible with ACP mcpServers parameter.
 */
export function getGeminiMcpServersForAcp(): unknown[] {
  try {
    if (!existsSync(GEMINI_SETTINGS_PATH)) {
      return [];
    }

    const content = readFileSync(GEMINI_SETTINGS_PATH, 'utf-8');
    const settings: GeminiSettings = JSON.parse(content);

    if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
      return [];
    }

    // Convert to ACP-compatible format
    return Object.entries(settings.mcpServers)
      .map(([name, config]) => {
        const server = config as GeminiMcpServer;

        if (server.command) {
          // STDIO type server
          return {
            name,
            command: server.command,
            args: server.args || [],
            env: server.env ? Object.entries(server.env).map(([key, value]) => ({ name: key, value })) : [],
          };
        }

        if (server.url) {
          // HTTP/SSE type server
          return {
            name,
            type: server.type || 'sse',
            url: server.url,
            headers: server.headers || [],
          };
        }

        return null;
      })
      .filter(Boolean);
  } catch (error) {
    console.error('Failed to read Gemini MCP servers for ACP:', error);
    return [];
  }
}
