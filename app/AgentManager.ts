import os from 'node:os';
import {
  createCliAgent,
  validateAgentType,
  SUPPORTED_AGENTS,
  type AgentType,
  type BaseCliAgent,
} from '../core/agents/index.js';
import { createAcpRuntime, type AcpRuntime } from '../acp/runtimeManager.js';
import { buildPermissionResponse, noOpAcpFileOperation } from '../acp/clientHelpers.js';
import { getErrorMessage, logInfo } from '../utils/error.js';
import { ensureMemoryFile } from '../utils/memory.js';
import type { Config } from '../utils/config.js';

export interface AgentManagerOptions {
  config: Config;
  buildPromptWithMemory: (userPrompt: string) => Promise<string>;
}

export class AgentManager {
  private cliAgent: BaseCliAgent;
  private acpRuntime: AcpRuntime;
  private config: Config;

  constructor(options: AgentManagerOptions) {
    this.config = options.config;

    const agentCommand = this.getAgentCommand(this.config.CLI_AGENT);

    let cliAgentType: AgentType;
    try {
      cliAgentType = validateAgentType(this.config.CLI_AGENT);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      console.error(`Available agents: ${SUPPORTED_AGENTS.join(', ')}`);
      process.exit(1);
    }

    this.cliAgent = createCliAgent(cliAgentType, {
      command: agentCommand,
      approvalMode: this.config.CLI_AGENT_APPROVAL_MODE,
      model: this.config.CLI_AGENT_MODEL,
      includeDirectories: [this.config.CLAWLESS_HOME, os.homedir()],
      killGraceMs: this.config.CLI_AGENT_KILL_GRACE_MS,
      acpMcpServersJson: this.config.ACP_MCP_SERVERS_JSON,
    });

    const GEMINI_STDERR_TAIL_MAX = 4000;

    this.acpRuntime = createAcpRuntime({
      cliAgent: this.cliAgent,
      acpPermissionStrategy: this.config.ACP_PERMISSION_STRATEGY,
      acpStreamStdout: this.config.ACP_STREAM_STDOUT,
      acpDebugStream: this.config.ACP_DEBUG_STREAM,
      acpTimeoutMs: this.config.CLI_AGENT_TIMEOUT_MS,
      acpNoOutputTimeoutMs: this.config.CLI_AGENT_NO_OUTPUT_TIMEOUT_MS,
      acpPrewarmRetryMs: this.config.ACP_PREWARM_RETRY_MS,
      acpPrewarmMaxRetries: this.config.ACP_PREWARM_MAX_RETRIES,
      acpMcpServersJson: this.config.ACP_MCP_SERVERS_JSON,
      stderrTailMaxChars: GEMINI_STDERR_TAIL_MAX,
      buildPromptWithMemory: options.buildPromptWithMemory,
      ensureMemoryFile: () => ensureMemoryFile(this.config.MEMORY_FILE_PATH, logInfo),
      buildPermissionResponse,
      noOpAcpFileOperation,
      getErrorMessage,
      logInfo,
    });
  }

  private getAgentCommand(cliAgent: string): string {
    switch (cliAgent) {
      case 'opencode':
        return 'opencode';
      case 'claude':
        return 'claude-agent-acp';
      default:
        return 'gemini';
    }
  }

  public validateCliAgentOrExit(): void {
    const validation = this.cliAgent.validate();
    if (!validation.valid) {
      console.error(`Error: ${validation.error}`);
      process.exit(1);
    }
  }

  public getCliAgent(): BaseCliAgent {
    return this.cliAgent;
  }

  public getAcpRuntime(): AcpRuntime {
    return this.acpRuntime;
  }

  public scheduleAcpPrewarm(reason: string): void {
    this.acpRuntime.scheduleAcpPrewarm(reason);
  }

  public async shutdown(reason: string): Promise<void> {
    await this.acpRuntime.shutdownAcpRuntime(reason);
  }

  public requestManualAbort(): void {
    this.acpRuntime.requestManualAbort();
  }
}
