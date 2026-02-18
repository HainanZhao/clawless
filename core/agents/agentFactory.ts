import type { BaseCliAgent, CliAgentConfig } from './BaseCliAgent.js';
import { GeminiAgent } from './GeminiAgent.js';
import { OpencodeAgent } from './OpencodeAgent.js';
import { ClaudeCodeAgent } from './ClaudeCodeAgent.js';

export const SUPPORTED_AGENTS = ['gemini', 'opencode', 'claude'] as const;
export type AgentType = (typeof SUPPORTED_AGENTS)[number];

/**
 * Factory function to create CLI agent instances based on type
 */
export function createCliAgent(agentType: AgentType, config: CliAgentConfig): BaseCliAgent {
  switch (agentType) {
    case 'gemini':
      return new GeminiAgent(config);
    case 'opencode':
      return new OpencodeAgent(config);
    case 'claude':
      return new ClaudeCodeAgent(config);
    default:
      throw new Error(`Unsupported agent type: ${agentType}. Supported types: ${SUPPORTED_AGENTS.join(', ')}`);
  }
}

/**
 * Validate agent type from string
 */
export function validateAgentType(value: string): AgentType {
  const normalized = value.trim().toLowerCase();
  if (!SUPPORTED_AGENTS.includes(normalized as AgentType)) {
    throw new Error(`Invalid CLI_AGENT value: ${value}. Supported values: ${SUPPORTED_AGENTS.join(', ')}`);
  }
  return normalized as AgentType;
}
