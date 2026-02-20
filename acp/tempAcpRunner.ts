import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { BaseCliAgent } from '../core/agents/index.js';

export interface TempAcpRunnerOptions {
  scheduleId: string;
  promptForAgent: string;
  cliAgent: BaseCliAgent;
  cwd: string;
  timeoutMs: number;
  // Kept for interface compatibility with existing call sites if any, though unused in runPromptWithCli
  noOutputTimeoutMs?: number;
  permissionStrategy?: string;
  stderrTailMaxChars?: number;
  logInfo: (message: string, details?: unknown) => void;
  acpMcpServersJson?: string;
  acpDebugStream?: boolean;
}

/**
 * Terminates a child process gracefully with SIGTERM, then escalates to SIGKILL if needed.
 */
function terminateProcessGracefully(
  childProcess: ChildProcessWithoutNullStreams,
  agentDisplayName: string,
  killGraceMs: number,
  logInfo: (message: string, details?: unknown) => void,
  details?: Record<string, unknown>,
) {
  return new Promise<void>((resolve) => {
    if (!childProcess || childProcess.killed || childProcess.exitCode !== null) {
      resolve();
      return;
    }

    let settled = false;

    const finalize = (reason: string) => {
      if (settled) {
        return;
      }
      settled = true;
      logInfo(`${agentDisplayName} process termination finalized`, {
        reason,
        pid: childProcess.pid,
        ...details,
      });
      resolve();
    };

    childProcess.once('exit', () => finalize('exit'));

    logInfo(`Sending SIGTERM to ${agentDisplayName} process`, {
      pid: childProcess.pid,
      graceMs: killGraceMs,
      ...details,
    });
    childProcess.kill('SIGTERM');

    setTimeout(
      () => {
        if (settled || childProcess.killed || childProcess.exitCode !== null) {
          finalize('already-exited');
          return;
        }

        logInfo(`Escalating ${agentDisplayName} process termination to SIGKILL`, {
          pid: childProcess.pid,
          ...details,
        });

        childProcess.kill('SIGKILL');
        finalize('sigkill');
      },
      Math.max(0, killGraceMs),
    );
  });
}

/**
 * Executes a single prompt using the CLI's standard prompt mode (-p).
 * This is simpler than ACP and suitable for one-shot background tasks.
 */
export async function runPromptWithCli(options: TempAcpRunnerOptions): Promise<string> {
  const { scheduleId, promptForAgent, cliAgent, cwd, timeoutMs, logInfo } = options;

  const command = cliAgent.getCommand();
  const args = cliAgent.buildPromptArgs(promptForAgent);
  const agentDisplayName = cliAgent.getDisplayName();
  const commandToken = command.split(/[\\/]/).pop() || command;
  const stderrPrefixToken = commandToken.toLowerCase().replace(/\s+/g, '-');
  const killGraceMs = cliAgent.getKillGraceMs();

  const tempProcess = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
  });

  logInfo(`Scheduler temp ${agentDisplayName} process started (prompt mode)`, {
    scheduleId,
    pid: tempProcess.pid,
    command,
    args: args.slice(0, -1).concat('[PROMPT]'), // Hide prompt in logs
  });

  return new Promise<string>((resolve, reject) => {
    let stdoutData = '';
    let stderrData = '';
    let settled = false;

    const overallTimeout = setTimeout(async () => {
      if (settled) return;
      settled = true;
      logInfo(`Scheduler temp ${agentDisplayName} prompt timed out`, { scheduleId, timeoutMs });

      await terminateProcessGracefully(
        tempProcess as unknown as ChildProcessWithoutNullStreams,
        agentDisplayName,
        killGraceMs,
        logInfo,
        { scheduleId },
      );

      reject(new Error(`Scheduler ${agentDisplayName} prompt timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    tempProcess.stdout.on('data', (chunk: Buffer) => {
      stdoutData += chunk.toString();
    });

    tempProcess.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrData += text;
      if (text.trim()) {
        console.error(`[${stderrPrefixToken}:scheduler:${scheduleId}] ${text.trim()}`);
      }
    });

    tempProcess.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimeout);
      logInfo(`Scheduler temp ${agentDisplayName} process error`, { scheduleId, error: error.message });
      reject(error);
    });

    tempProcess.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimeout);

      logInfo(`Scheduler temp ${agentDisplayName} process exited`, { scheduleId, code, signal });

      if (code === 0) {
        resolve(stdoutData.trim() || 'No response received.');
      } else {
        const errorMsg = `Agent exited with code ${code}${signal ? ` (signal ${signal})` : ''}. ${stderrData.slice(-500)}`;
        reject(new Error(errorMsg));
      }
    });
  });
}
