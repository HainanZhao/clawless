/**
 * Base interface for CLI-based agent implementations.
 * This abstraction allows Clawless to support multiple agent backends
 * (e.g., Gemini CLI, OpenCode, etc.) through a common interface.
 */

import { spawnSync } from 'node:child_process';

export interface CliAgentConfig {
  command: string;
  approvalMode?: string;
  model?: string;
  includeDirectories?: string[];
  killGraceMs?: number;
  acpMcpServersJson?: string;
}

export interface CliAgentCapabilities {
  supportsAcp: boolean;
  supportsApprovalMode: boolean;
  supportsModelSelection: boolean;
  supportsIncludeDirectories: boolean;
}

export abstract class BaseCliAgent {
  protected config: CliAgentConfig;

  constructor(config: CliAgentConfig) {
    this.config = config;
  }

  /**
   * Get the CLI command name (e.g., 'gemini', 'opencode')
   */
  abstract getCommand(): string;

  /**
   * Build command-line arguments for ACP mode
   * Default implementation works for most ACP-capable agents
   */
  buildAcpArgs(): string[] {
    const args = ['--experimental-acp'];

    if (this.config.includeDirectories && this.config.includeDirectories.length > 0) {
      const includeDirectorySet = new Set(this.config.includeDirectories);
      for (const includeDirectory of includeDirectorySet) {
        args.push('--include-directories', includeDirectory);
      }
    }

    if (this.config.approvalMode) {
      args.push('--approval-mode', this.config.approvalMode);
    }

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    return args;
  }

  /**
   * Build command-line arguments for standard prompt mode (one-shot)
   */
  buildPromptArgs(promptText: string): string[] {
    const args: string[] = [];

    if (this.config.includeDirectories && this.config.includeDirectories.length > 0) {
      const includeDirectorySet = new Set(this.config.includeDirectories);
      for (const includeDirectory of includeDirectorySet) {
        args.push('--include-directories', includeDirectory);
      }
    }

    if (this.config.approvalMode) {
      args.push('--approval-mode', this.config.approvalMode);
    }

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    // Always use prompt mode for one-shot execution
    args.push('-p', promptText);

    return args;
  }

  /**
   * Get MCP servers to pass to ACP session.
   * Override this in subclasses to provide MCP server configurations.
   * Returns array of MCP server configs in ACP format.
   */
  getMcpServersForAcp?(): unknown[];

  /**
   * Get agent capabilities
   */
  abstract getCapabilities(): CliAgentCapabilities;

  /**
   * Get the display name of the agent
   */
  abstract getDisplayName(): string;

  /**
   * Validate that the agent CLI is available and working
   * Default implementation checks if the command exists and can be executed
   */
  validate(): { valid: boolean; error?: string } {
    try {
      const command = this.getCommand();
      const result = spawnSync(command, ['--version'], {
        stdio: 'ignore',
        timeout: 10000,
        killSignal: 'SIGKILL',
      });

      if ((result as any).error?.code === 'ENOENT') {
        return {
          valid: false,
          error: `${this.getDisplayName()} executable not found: ${command}. Install ${this.getDisplayName()} and ensure it is available on PATH.`,
        };
      }

      if ((result as any).error) {
        return {
          valid: false,
          error: `Failed to execute ${this.getDisplayName()} (${command}): ${(result as any).error.message}`,
        };
      }

      return { valid: true };
    } catch (error: any) {
      return {
        valid: false,
        error: `Failed to validate ${this.getDisplayName()}: ${error.message}`,
      };
    }
  }

  /**
   * Get the grace period for process termination
   */
  getKillGraceMs(): number {
    return this.config.killGraceMs ?? 10000;
  }
}
