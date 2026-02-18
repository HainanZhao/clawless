import { BaseCliAgent, type CliAgentCapabilities } from './BaseCliAgent.js';
import { getGeminiMcpServerNames, getGeminiMcpServersForAcp } from '../../utils/geminiMcpHelpers.js';

/**
 * Gemini CLI agent implementation.
 * Supports Google's Gemini CLI with ACP (Agent Communication Protocol).
 */
export class GeminiAgent extends BaseCliAgent {
  getCommand(): string {
    return this.config.command;
  }

  getDisplayName(): string {
    return 'Gemini CLI';
  }

  /**
   * Override to add --allowed-mcp-server-names based on Gemini settings.
   * This ensures MCP tools (like gitlab, context7) are available in ACP mode.
   */
  buildAcpArgs(): string[] {
    const args = super.buildAcpArgs();

    // Get MCP server names from Gemini settings
    const mcpServerNames = getGeminiMcpServerNames();
    if (mcpServerNames.length > 0) {
      args.push('--allowed-mcp-server-names', ...mcpServerNames);
    }

    return args;
  }

  /**
   * Provide MCP server configurations from Gemini settings.
   * This passes the actual MCP server configs to the ACP session.
   */
  getMcpServersForAcp(): unknown[] {
    return getGeminiMcpServersForAcp();
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
