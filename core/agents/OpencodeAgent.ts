import { BaseCliAgent, type CliAgentCapabilities } from './BaseCliAgent.js';

/**
 * OpenCode CLI agent implementation.
 * Supports OpenCode with ACP (Agent Communication Protocol).
 */
export class OpencodeAgent extends BaseCliAgent {
  getCommand(): string {
    return this.config.command;
  }

  buildAcpArgs(): string[] {
    const args = ['acp'];
    // Add MCP servers if configured via environment variable
    const raw = process.env.ACP_MCP_SERVERS_JSON;
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
