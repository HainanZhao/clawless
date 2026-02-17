import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { getMcpServersForSession } from './mcpServerHelpers.js';
import type { BaseCliAgent } from '../core/agents/index.js';

type LogInfoFn = (message: string, details?: unknown) => void;
type GetErrorMessageFn = (error: unknown, fallbackMessage?: string) => string;

type CreateAcpRuntimeParams = {
  cliAgent: BaseCliAgent;
  acpPermissionStrategy: string;
  acpStreamStdout: boolean;
  acpDebugStream: boolean;
  acpTimeoutMs: number;
  acpNoOutputTimeoutMs: number;
  acpPrewarmRetryMs: number;
  stderrTailMaxChars: number;
  buildPromptWithMemory: (userPrompt: string) => Promise<string>;
  ensureMemoryFile: () => void;
  buildPermissionResponse: (options: any, strategy: string) => any;
  noOpAcpFileOperation: (params: any) => any;
  getErrorMessage: GetErrorMessageFn;
  logInfo: LogInfoFn;
};

export function createAcpRuntime({
  cliAgent,
  acpPermissionStrategy,
  acpStreamStdout,
  acpDebugStream,
  acpTimeoutMs,
  acpNoOutputTimeoutMs,
  acpPrewarmRetryMs,
  stderrTailMaxChars,
  buildPromptWithMemory,
  ensureMemoryFile,
  buildPermissionResponse,
  noOpAcpFileOperation,
  getErrorMessage,
  logInfo,
}: CreateAcpRuntimeParams) {
  const defaultAcpPrewarmMaxRetries = 10;
  const acpPrewarmMaxRetriesEnv = process.env.ACP_PREWARM_MAX_RETRIES;
  const parsedAcpPrewarmMaxRetries = Number.parseInt(acpPrewarmMaxRetriesEnv ?? `${defaultAcpPrewarmMaxRetries}`, 10);
  const acpPrewarmMaxRetries = Number.isNaN(parsedAcpPrewarmMaxRetries)
    ? defaultAcpPrewarmMaxRetries
    : parsedAcpPrewarmMaxRetries;

  const agentCommand = cliAgent.getCommand();
  const agentDisplayName = cliAgent.getDisplayName();
  const commandToken = agentCommand.split(/[\\/]/).pop() || agentCommand;
  const stderrPrefixToken = commandToken.toLowerCase().replace(/\s+/g, '-');
  const killGraceMs = cliAgent.getKillGraceMs();

  let agentProcess: any = null;
  let acpConnection: any = null;
  let acpSessionId: any = null;
  let acpInitPromise: Promise<void> | null = null;
  let activePromptCollector: any = null;
  let manualAbortRequested = false;
  let acpPrewarmRetryTimer: NodeJS.Timeout | null = null;
  let acpPrewarmRetryAttempts = 0;
  let agentStderrTail = '';

  const appendAgentStderrTail = (text: string) => {
    agentStderrTail = `${agentStderrTail}${text}`;
    if (agentStderrTail.length > stderrTailMaxChars) {
      agentStderrTail = agentStderrTail.slice(-stderrTailMaxChars);
    }
  };

  const terminateProcessGracefully = (
    childProcess: ChildProcessWithoutNullStreams,
    processLabel: string,
    details?: Record<string, unknown>,
  ) => {
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
          processLabel,
          reason,
          pid: childProcess.pid,
          ...details,
        });
        resolve();
      };

      childProcess.once('exit', () => finalize('exit'));

      logInfo(`Sending SIGTERM to ${agentDisplayName} process`, {
        processLabel,
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
            processLabel,
            pid: childProcess.pid,
            ...details,
          });

          childProcess.kill('SIGKILL');
          finalize('sigkill');
        },
        Math.max(0, killGraceMs),
      );
    });
  };

  const hasHealthyAcpRuntime = () => {
    return Boolean(acpConnection && acpSessionId && agentProcess && !agentProcess.killed);
  };

  const hasActiveAcpPrompt = () => {
    return Boolean(activePromptCollector && acpConnection && acpSessionId);
  };

  const cancelActiveAcpPrompt = async () => {
    try {
      if (acpConnection && acpSessionId) {
        await acpConnection.cancel({ sessionId: acpSessionId });
      }
    } catch (_) {}
  };

  const shutdownAcpRuntime = async (reason: string) => {
    const processToStop = agentProcess;
    const runtimeSessionId = acpSessionId;

    activePromptCollector = null;
    acpConnection = null;
    acpSessionId = null;
    acpInitPromise = null;
    agentProcess = null;
    agentStderrTail = '';

    if (processToStop && !processToStop.killed && processToStop.exitCode === null) {
      await terminateProcessGracefully(processToStop, 'main-acp-runtime', {
        reason,
        sessionId: runtimeSessionId,
      });
    }
  };

  const buildAgentAcpArgs = () => {
    return cliAgent.buildAcpArgs();
  };

  const acpClient = {
    async requestPermission(params: any) {
      return buildPermissionResponse(params?.options, acpPermissionStrategy);
    },

    async sessionUpdate(params: any) {
      if (!activePromptCollector || params.sessionId !== acpSessionId) {
        return;
      }

      activePromptCollector.onActivity();

      if (params.update?.sessionUpdate === 'agent_message_chunk' && params.update?.content?.type === 'text') {
        const chunkText = params.update.content.text;
        activePromptCollector.append(chunkText);
        if (acpStreamStdout && chunkText) {
          process.stdout.write(chunkText);
        }
      }
    },

    async readTextFile(params: any) {
      return noOpAcpFileOperation(params);
    },

    async writeTextFile(params: any) {
      return noOpAcpFileOperation(params);
    },
  };

  const resetAcpRuntime = () => {
    logInfo('Resetting ACP runtime state');
    void shutdownAcpRuntime('runtime-reset');
    scheduleAcpPrewarm('runtime reset');
  };

  const ensureAcpSession = async () => {
    ensureMemoryFile();

    if (acpConnection && acpSessionId && agentProcess && !agentProcess.killed) {
      return;
    }

    if (acpInitPromise) {
      await acpInitPromise;
      return;
    }

    acpInitPromise = (async () => {
      const args = buildAgentAcpArgs();
      const { source: mcpServersSource, mcpServers } = getMcpServersForSession({
        logInfo,
        getErrorMessage,
        invalidEnvMessage: 'Invalid ACP_MCP_SERVERS_JSON; using empty mcpServers array',
      });
      const mcpServerNames = mcpServers
        .map((server) => {
          if (server && typeof server === 'object' && 'name' in server) {
            return String((server as { name?: unknown }).name ?? '');
          }

          return '';
        })
        .filter((name) => name.length > 0);

      logInfo(`Starting ${agentDisplayName} ACP process`, {
        command: agentCommand,
        args,
      });
      agentStderrTail = '';
      agentProcess = spawn(agentCommand, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd(),
      });

      agentProcess.stderr.on('data', (chunk: Buffer) => {
        const rawText = chunk.toString();
        appendAgentStderrTail(rawText);
        const text = rawText.trim();
        if (text) {
          console.error(`[${stderrPrefixToken}] ${text}`);
        }
        if (activePromptCollector) {
          activePromptCollector.onActivity();
        }
      });

      agentProcess.on('error', (error: Error) => {
        console.error(`${agentDisplayName} ACP process error:`, error.message);
        resetAcpRuntime();
      });

      agentProcess.on('close', (code: number, signal: string) => {
        console.error(`${agentDisplayName} ACP process closed (code=${code}, signal=${signal})`);
        resetAcpRuntime();
      });

      const input = Writable.toWeb(agentProcess.stdin) as unknown as WritableStream<Uint8Array>;
      const output = Readable.toWeb(agentProcess.stdout) as unknown as ReadableStream<Uint8Array>;
      const stream = acp.ndJsonStream(input, output);

      acpConnection = new acp.ClientSideConnection(() => acpClient, stream);

      try {
        await acpConnection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        logInfo('ACP connection initialized');

        const session = await acpConnection.newSession({
          cwd: process.cwd(),
          mcpServers,
        });

        acpSessionId = session.sessionId;
        logInfo('ACP session ready', {
          sessionId: acpSessionId,
          mcpServersMode: mcpServersSource,
          mcpServersCount: mcpServers.length,
          mcpServerNames,
        });
      } catch (error: any) {
        const baseMessage = getErrorMessage(error);
        const isInternalError = baseMessage.includes('Internal error');
        const hint = isInternalError
          ? `${agentDisplayName} ACP newSession returned Internal error. This is often caused by a local MCP server or skill initialization issue. Try launching the CLI directly and checking MCP/skills diagnostics.`
          : '';

        logInfo('ACP initialization failed', {
          error: baseMessage,
          stderrTail: agentStderrTail || '(empty)',
        });

        resetAcpRuntime();
        throw new Error(hint ? `${baseMessage}. ${hint}` : baseMessage);
      }
    })();

    try {
      await acpInitPromise;
    } finally {
      acpInitPromise = null;
    }
  };

  const scheduleAcpPrewarm = (reason: string) => {
    if (hasHealthyAcpRuntime() || acpInitPromise) {
      return;
    }

    if (acpPrewarmRetryTimer) {
      return;
    }

    logInfo('Triggering ACP prewarm', { reason });

    ensureAcpSession()
      .then(() => {
        acpPrewarmRetryAttempts = 0;
        logInfo(`${agentDisplayName} ACP prewarm complete`);
      })
      .catch((error: unknown) => {
        logInfo(`${agentDisplayName} ACP prewarm failed`, { error: getErrorMessage(error) });

        acpPrewarmRetryAttempts += 1;
        if (acpPrewarmMaxRetries > 0 && acpPrewarmRetryAttempts >= acpPrewarmMaxRetries) {
          logInfo(`${agentDisplayName} ACP prewarm retries exhausted; stopping automatic retries`, {
            attempts: acpPrewarmRetryAttempts,
            maxRetries: acpPrewarmMaxRetries,
          });
          return;
        }

        if (acpPrewarmRetryMs > 0) {
          acpPrewarmRetryTimer = setTimeout(() => {
            acpPrewarmRetryTimer = null;
            scheduleAcpPrewarm('retry');
          }, acpPrewarmRetryMs);
        }
      });
  };

  const runAcpPrompt = async (promptText: string, onChunk?: (chunk: string) => void) => {
    await ensureAcpSession();
    const promptInvocationId = `acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    logInfo('Starting ACP prompt', {
      invocationId: promptInvocationId,
      sessionId: acpSessionId,
      promptLength: promptText.length,
    });
    const promptForGemini = await buildPromptWithMemory(promptText);

    return new Promise<string>((resolve, reject) => {
      let fullResponse = '';
      let isSettled = false;
      let noOutputTimeout: NodeJS.Timeout | null = null;
      const startedAt = Date.now();
      let chunkCount = 0;
      let firstChunkAt: number | null = null;

      const clearTimers = () => {
        clearTimeout(overallTimeout);
        if (noOutputTimeout) {
          clearTimeout(noOutputTimeout);
        }
      };

      const failOnce = (error: Error) => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        manualAbortRequested = false;
        clearTimers();
        activePromptCollector = null;
        logInfo('ACP prompt failed', {
          invocationId: promptInvocationId,
          sessionId: acpSessionId,
          chunkCount,
          firstChunkDelayMs: firstChunkAt ? firstChunkAt - startedAt : null,
          elapsedMs: Date.now() - startedAt,
          error: getErrorMessage(error),
        });
        reject(error);
      };

      const resolveOnce = (value: string) => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        manualAbortRequested = false;
        clearTimers();
        activePromptCollector = null;
        logInfo('ACP prompt completed', {
          invocationId: promptInvocationId,
          sessionId: acpSessionId,
          chunkCount,
          firstChunkDelayMs: firstChunkAt ? firstChunkAt - startedAt : null,
          elapsedMs: Date.now() - startedAt,
          responseLength: value.length,
        });
        resolve(value);
      };

      const refreshNoOutputTimer = () => {
        if (!acpNoOutputTimeoutMs || acpNoOutputTimeoutMs <= 0) {
          return;
        }

        if (noOutputTimeout) {
          clearTimeout(noOutputTimeout);
        }

        noOutputTimeout = setTimeout(async () => {
          await cancelActiveAcpPrompt();
          failOnce(new Error(`${agentDisplayName} ACP produced no output for ${acpNoOutputTimeoutMs}ms`));
        }, acpNoOutputTimeoutMs);
      };

      const overallTimeout = setTimeout(async () => {
        await cancelActiveAcpPrompt();
        failOnce(new Error(`${agentDisplayName} ACP timed out after ${acpTimeoutMs}ms`));
      }, acpTimeoutMs);

      activePromptCollector = {
        onActivity: refreshNoOutputTimer,
        append: (textChunk: string) => {
          refreshNoOutputTimer();
          chunkCount += 1;
          if (!firstChunkAt) {
            firstChunkAt = Date.now();
          }
          if (acpDebugStream) {
            logInfo('ACP chunk received', {
              invocationId: promptInvocationId,
              chunkIndex: chunkCount,
              chunkLength: textChunk.length,
              elapsedMs: Date.now() - startedAt,
              bufferLengthBeforeAppend: fullResponse.length,
            });
          }
          fullResponse += textChunk;
          if (onChunk) {
            try {
              onChunk(textChunk);
            } catch (_) {}
          }
        },
      };

      refreshNoOutputTimer();

      acpConnection
        .prompt({
          sessionId: acpSessionId,
          prompt: [
            {
              type: 'text',
              text: promptForGemini,
            },
          ],
        })
        .then((result: any) => {
          if (acpDebugStream) {
            logInfo('ACP prompt stop reason', {
              invocationId: promptInvocationId,
              stopReason: result?.stopReason || '(none)',
              chunkCount,
              bufferedLength: fullResponse.length,
              deliveryMode: 'live-preview-then-final',
            });
          }
          if (result?.stopReason === 'cancelled' && !fullResponse) {
            failOnce(
              new Error(
                manualAbortRequested
                  ? `${agentDisplayName} ACP prompt was aborted by user`
                  : `${agentDisplayName} ACP prompt was cancelled`,
              ),
            );
            return;
          }
          resolveOnce(fullResponse || 'No response received.');
        })
        .catch((error: any) => {
          failOnce(new Error(error?.message || `${agentDisplayName} ACP prompt failed`));
        });
    });
  };

  return {
    buildAgentAcpArgs,
    runAcpPrompt,
    scheduleAcpPrewarm,
    shutdownAcpRuntime,
    cancelActiveAcpPrompt,
    hasActiveAcpPrompt,
    requestManualAbort: () => {
      manualAbortRequested = true;
    },
    getRuntimeState: () => ({
      acpSessionReady: Boolean(acpSessionId),
      agentProcessRunning: Boolean(agentProcess && !agentProcess.killed),
    }),
  };
}
