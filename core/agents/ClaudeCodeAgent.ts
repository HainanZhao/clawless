import { BaseCliAgent, type CliAgentCapabilities } from './BaseCliAgent.js';

/**
 * Claude Agent ACP adapter implementation.
 * Uses @zed-industries/claude-agent-acp which provides ACP protocol support
 * by wrapping the Claude Agent SDK.
 */
export class ClaudeCodeAgent extends BaseCliAgent {
  getCommand(): string {
    return this.config.command;
  }

  /**
   * Map generic approval mode to Claude Agent's permission mode
   */
  private mapApprovalMode(approvalMode?: string): string | undefined {
    if (!approvalMode) return undefined;

    // Map common approval modes to Claude Agent's permission modes
    const modeMap: Record<string, string> = {
      yolo: 'bypassPermissions',
      auto_edit: 'acceptEdits',
      default: 'default',
      plan: 'plan',
    };

    return modeMap[approvalMode] || 'default';
  }

  buildAcpArgs(): string[] {
    // Claude Agent ACP adapter uses standard ACP protocol
    // No special flags needed - it's ACP-native
    const args: string[] = [];

    if (this.config.includeDirectories && this.config.includeDirectories.length > 0) {
      const includeDirectorySet = new Set(this.config.includeDirectories);
      for (const includeDirectory of includeDirectorySet) {
        args.push('--add-dir', includeDirectory);
      }
    }

    // Use permission-mode for Claude Agent
    const permissionMode = this.mapApprovalMode(this.config.approvalMode);
    if (permissionMode) {
      args.push('--permission-mode', permissionMode);
    }

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    return args;
  }

  getDisplayName(): string {
    return 'Claude Agent ACP';
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
