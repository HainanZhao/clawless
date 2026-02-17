import { spawnSync } from 'node:child_process';
import { BaseCliAgent, type CliAgentCapabilities, type CliAgentConfig } from './BaseCliAgent.js';

/**
 * Gemini CLI agent implementation.
 * Supports Google's Gemini CLI with ACP (Agent Communication Protocol).
 */
export class GeminiAgent extends BaseCliAgent {
  constructor(config: CliAgentConfig) {
    super(config);
  }

  getCommand(): string {
    return this.config.command;
  }

  getDisplayName(): string {
    return 'Gemini CLI';
  }

  getCapabilities(): CliAgentCapabilities {
    return {
      supportsAcp: true,
      supportsApprovalMode: true,
      supportsModelSelection: true,
      supportsIncludeDirectories: true,
    };
  }

  validate(): { valid: boolean; error?: string } {
    try {
      const result = spawnSync(this.config.command, ['--version'], {
        stdio: 'ignore',
        timeout: 10000,
        killSignal: 'SIGKILL',
      });

      if ((result as any).error?.code === 'ENOENT') {
        return {
          valid: false,
          error: `${this.getDisplayName()} executable not found: ${this.config.command}. Install ${this.getDisplayName()} or set CLI_AGENT_COMMAND to a valid executable path.`,
        };
      }

      if ((result as any).error) {
        return {
          valid: false,
          error: `Failed to execute ${this.getDisplayName()} (${this.config.command}): ${(result as any).error.message}`,
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
}
