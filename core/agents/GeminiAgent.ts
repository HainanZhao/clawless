import { BaseCliAgent, type CliAgentCapabilities } from './BaseCliAgent.js';

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

  getCapabilities(): CliAgentCapabilities {
    return {
      supportsAcp: true,
      supportsApprovalMode: true,
      supportsModelSelection: true,
      supportsIncludeDirectories: true,
    };
  }
}
