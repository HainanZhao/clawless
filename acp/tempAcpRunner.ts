import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { buildPermissionResponse, noOpAcpFileOperation } from './clientHelpers.js';
import { getErrorMessage } from '../utils/error.js';

const ACP_DEBUG_STREAM = String(process.env.ACP_DEBUG_STREAM || '').toLowerCase() === 'true';
const GEMINI_KILL_GRACE_MS = parseInt(process.env.GEMINI_KILL_GRACE_MS || '5000', 10);

export interface TempAcpRunnerOptions {
  scheduleId: string;
  promptForGemini: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  noOutputTimeoutMs: number;
  permissionStrategy: string;
  stderrTailMaxChars?: number;
  logInfo: (message: string, details?: unknown) => void;
}

export async function runPromptWithTempAcp(options: TempAcpRunnerOptions): Promise<string> {
  const {
    scheduleId,
    promptForGemini,
    command,
    args,
    cwd,
    timeoutMs,
    noOutputTimeoutMs,
    permissionStrategy,
    stderrTailMaxChars = 4000,
    logInfo,
  } = options;

  const tempProcess = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
  });

  logInfo('Scheduler temp Gemini ACP process started', {
    scheduleId,
    pid: tempProcess.pid,
    command,
    args,
  });

  let tempConnection: any = null;
  let tempSessionId: string | null = null;
  let tempCollector: { onActivity: () => void; append: (chunk: string) => void } | null = null;
  let tempStderrTail = '';
  let noOutputTimeout: NodeJS.Timeout | null = null;
  let overallTimeout: NodeJS.Timeout | null = null;
  let cleanedUp = false;

  const terminateProcessGracefully = () => {
    return new Promise<void>((resolve) => {
      if (!tempProcess || tempProcess.killed || tempProcess.exitCode !== null) {
        resolve();
        return;
      }

      let settled = false;

      const finalize = (reason: string) => {
        if (settled) {
          return;
        }
        settled = true;
        logInfo('Scheduler temp Gemini process termination finalized', {
          scheduleId,
          pid: tempProcess.pid,
          reason,
        });
        resolve();
      };

      tempProcess.once('exit', () => finalize('exit'));

      logInfo('Scheduler temp Gemini process SIGTERM', {
        scheduleId,
        pid: tempProcess.pid,
        graceMs: GEMINI_KILL_GRACE_MS,
      });
      tempProcess.kill('SIGTERM');

      setTimeout(() => {
        if (settled || tempProcess.killed || tempProcess.exitCode !== null) {
          finalize('already-exited');
          return;
        }

        logInfo('Scheduler temp Gemini process SIGKILL escalation', {
          scheduleId,
          pid: tempProcess.pid,
        });
        tempProcess.kill('SIGKILL');
        finalize('sigkill');
      }, Math.max(0, GEMINI_KILL_GRACE_MS));
    });
  };

  const appendTempStderrTail = (text: string) => {
    tempStderrTail = `${tempStderrTail}${text}`;
    if (tempStderrTail.length > stderrTailMaxChars) {
      tempStderrTail = tempStderrTail.slice(-stderrTailMaxChars);
    }
  };

  const clearTimers = () => {
    if (noOutputTimeout) {
      clearTimeout(noOutputTimeout);
      noOutputTimeout = null;
    }
    if (overallTimeout) {
      clearTimeout(overallTimeout);
      overallTimeout = null;
    }
  };

  const cleanup = async () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    clearTimers();

    try {
      if (tempConnection && tempSessionId) {
        await tempConnection.cancel({ sessionId: tempSessionId });
      }
    } catch (_) {
    }

    if (!tempProcess.killed && tempProcess.exitCode === null) {
      await terminateProcessGracefully();
    }

    logInfo('Scheduler temp Gemini ACP process cleanup complete', {
      scheduleId,
      pid: tempProcess.pid,
    });
  };

  tempProcess.stderr.on('data', (chunk: Buffer) => {
    const rawText = chunk.toString();
    appendTempStderrTail(rawText);
    const text = rawText.trim();
    if (text) {
      console.error(`[gemini:scheduler:${scheduleId}] ${text}`);
    }
    tempCollector?.onActivity();
  });

  tempProcess.on('error', (error: Error) => {
    logInfo('Scheduler temp Gemini ACP process error', {
      scheduleId,
      pid: tempProcess.pid,
      error: error.message,
    });
  });

  tempProcess.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    logInfo('Scheduler temp Gemini ACP process exited', {
      scheduleId,
      pid: tempProcess.pid,
      code,
      signal,
    });
  });

  try {
    const input = Writable.toWeb(tempProcess.stdin) as unknown as WritableStream<Uint8Array>;
    const output = Readable.toWeb(tempProcess.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const tempClient = {
      async requestPermission(params: any) {
        return buildPermissionResponse(params?.options, permissionStrategy);
      },
      async sessionUpdate(params: any) {
        if (!tempCollector || params.sessionId !== tempSessionId) {
          return;
        }

        tempCollector.onActivity();

        if (params.update?.sessionUpdate === 'agent_message_chunk' && params.update?.content?.type === 'text') {
          const chunkText = params.update.content.text;
          tempCollector.append(chunkText);
        }
      },
      async readTextFile(_params: any) {
        return noOpAcpFileOperation(_params);
      },
      async writeTextFile(_params: any) {
        return noOpAcpFileOperation(_params);
      },
    };

    tempConnection = new acp.ClientSideConnection(() => tempClient, stream);

    await tempConnection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    const session = await tempConnection.newSession({
      cwd,
      mcpServers: [],
    });
    tempSessionId = session.sessionId;

    return await new Promise<string>((resolve, reject) => {
      let response = '';
      let settled = false;
      const startedAt = Date.now();
      let chunkCount = 0;
      let firstChunkAt: number | null = null;

      const settle = async (handler: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        await cleanup();
        handler();
      };

      const refreshNoOutputTimer = () => {
        if (!noOutputTimeoutMs || noOutputTimeoutMs <= 0) {
          return;
        }
        if (noOutputTimeout) {
          clearTimeout(noOutputTimeout);
        }
        noOutputTimeout = setTimeout(async () => {
          try {
            if (tempConnection && tempSessionId) {
              await tempConnection.cancel({ sessionId: tempSessionId });
            }
          } catch (_) {
          }

          await settle(() => reject(new Error(`Scheduler Gemini ACP produced no output for ${noOutputTimeoutMs}ms`)));
        }, noOutputTimeoutMs);
      };

      overallTimeout = setTimeout(async () => {
        try {
          if (tempConnection && tempSessionId) {
            await tempConnection.cancel({ sessionId: tempSessionId });
          }
        } catch (_) {
        }

        await settle(() => reject(new Error(`Scheduler Gemini ACP timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      tempCollector = {
        onActivity: refreshNoOutputTimer,
        append: (chunk: string) => {
          refreshNoOutputTimer();
          chunkCount += 1;
          if (!firstChunkAt) {
            firstChunkAt = Date.now();
          }
          if (ACP_DEBUG_STREAM) {
            logInfo('Scheduler ACP chunk received', {
              scheduleId,
              chunkIndex: chunkCount,
              chunkLength: chunk.length,
              elapsedMs: Date.now() - startedAt,
              bufferLengthBeforeAppend: response.length,
            });
          }
          response += chunk;
        },
      };

      refreshNoOutputTimer();

      tempConnection.prompt({
        sessionId: tempSessionId,
        prompt: [{ type: 'text', text: promptForGemini }],
      })
        .then(async (result: any) => {
          if (ACP_DEBUG_STREAM) {
            logInfo('Scheduler ACP prompt stop reason', {
              scheduleId,
              stopReason: result?.stopReason || '(none)',
              chunkCount,
              firstChunkDelayMs: firstChunkAt ? firstChunkAt - startedAt : null,
              elapsedMs: Date.now() - startedAt,
              bufferedLength: response.length,
            });
          }
          if (result?.stopReason === 'cancelled' && !response) {
            await settle(() => reject(new Error('Scheduler Gemini ACP prompt was cancelled')));
            return;
          }

          await settle(() => resolve(response || 'No response received.'));
        })
        .catch(async (error: any) => {
          await settle(() => reject(new Error(error?.message || 'Scheduler Gemini ACP prompt failed')));
        });
    });
  } catch (error: any) {
    logInfo('Scheduler temporary Gemini ACP run failed', {
      scheduleId,
      error: getErrorMessage(error),
      stderrTail: tempStderrTail || '(empty)',
    });
    throw error;
  } finally {
    await cleanup();
  }
}
