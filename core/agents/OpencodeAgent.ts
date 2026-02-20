import { BaseCliAgent, type CliAgentCapabilities } from './BaseCliAgent.js';
import { getOpenCodeMcpServersForAcp } from '../../utils/opencodeMcpHelpers.js';

/**
 * OpenCode CLI agent implementation.
 * Supports OpenCode with ACP (Agent Communication Protocol).
 */
export class OpencodeAgent extends BaseCliAgent {
  getCommand(): string {
    return this.config.command;
  }

  buildPromptArgs(promptText: string): string[] {
    const args = ['run'];

    if (this.config.model) {
      args.push('-m', this.config.model);
    }

    args.push(promptText);
    return args;
  }

  buildAcpArgs(): string[] {
    const args = ['acp'];

    // MCP server configs are passed via getMcpServersForAcp() to the ACP session
    // Also check explicit config as fallback
    const raw = this.config.acpMcpServersJson;
    if (raw) {
      try {
        const mcpServers = JSON.parse(raw);
        if (Array.isArray(mcpServers) && mcpServers.length > 0) {
          args.push('--mcp-servers', raw);
        }
      } catch (_) {
        // Ignore parse errors, fallback to no MCP servers
      }
    }
    return args;
  }

  /**
   * Provide MCP server configurations from OpenCode settings.
   */
  getMcpServersForAcp(): unknown[] {
    return getOpenCodeMcpServersForAcp();
  }

  getDisplayName(): string {
    return 'OpenCode';
  }

  getCapabilities(): CliAgentCapabilities {
    return {
      supportsAcp: true,
      supportsApprovalMode: true,
      supportsModelSelection: true,
      supportsIncludeDirectories: true,
    };
  }
}
