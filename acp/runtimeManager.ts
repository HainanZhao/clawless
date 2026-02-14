import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

type LogInfoFn = (message: string, details?: unknown) => void;
type GetErrorMessageFn = (error: unknown, fallbackMessage?: string) => string;

type CreateAcpRuntimeParams = {
  geminiCommand: string;
  includeDirectories: string[];
  geminiApprovalMode: string;
  geminiModel: string;
  acpPermissionStrategy: string;
  acpStreamStdout: boolean;
  acpDebugStream: boolean;
  acpTimeoutMs: number;
  acpNoOutputTimeoutMs: number;
  acpPrewarmRetryMs: number;
  geminiKillGraceMs: number;
  stderrTailMaxChars: number;
  buildPromptWithMemory: (userPrompt: string) => string;
  ensureMemoryFile: () => void;
  buildPermissionResponse: (options: any, strategy: string) => any;
  noOpAcpFileOperation: (params: any) => any;
  getErrorMessage: GetErrorMessageFn;
  logInfo: LogInfoFn;
};

export function createAcpRuntime({
  geminiCommand,
  includeDirectories,
  geminiApprovalMode,
  geminiModel,
  acpPermissionStrategy,
  acpStreamStdout,
  acpDebugStream,
  acpTimeoutMs,
  acpNoOutputTimeoutMs,
  acpPrewarmRetryMs,
  geminiKillGraceMs,
  stderrTailMaxChars,
  buildPromptWithMemory,
  ensureMemoryFile,
  buildPermissionResponse,
  noOpAcpFileOperation,
  getErrorMessage,
  logInfo,
}: CreateAcpRuntimeParams) {
  let geminiProcess: any = null;
  let acpConnection: any = null;
  let acpSessionId: any = null;
  let acpInitPromise: Promise<void> | null = null;
  let activePromptCollector: any = null;
  let manualAbortRequested = false;
  let acpPrewarmRetryTimer: NodeJS.Timeout | null = null;
  let geminiStderrTail = '';

  const appendGeminiStderrTail = (text: string) => {
    geminiStderrTail = `${geminiStderrTail}${text}`;
    if (geminiStderrTail.length > stderrTailMaxChars) {
      geminiStderrTail = geminiStderrTail.slice(-stderrTailMaxChars);
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
        logInfo('Gemini process termination finalized', {
          processLabel,
          reason,
          pid: childProcess.pid,
          ...details,
        });
        resolve();
      };

      childProcess.once('exit', () => finalize('exit'));

      logInfo('Sending SIGTERM to Gemini process', {
        processLabel,
        pid: childProcess.pid,
        graceMs: geminiKillGraceMs,
        ...details,
      });
      childProcess.kill('SIGTERM');

      setTimeout(() => {
        if (settled || childProcess.killed || childProcess.exitCode !== null) {
          finalize('already-exited');
          return;
        }

        logInfo('Escalating Gemini process termination to SIGKILL', {
          processLabel,
          pid: childProcess.pid,
          ...details,
        });

        childProcess.kill('SIGKILL');
        finalize('sigkill');
      }, Math.max(0, geminiKillGraceMs));
    });
  };

  const hasHealthyAcpRuntime = () => {
    return Boolean(acpConnection && acpSessionId && geminiProcess && !geminiProcess.killed);
  };

  const hasActiveAcpPrompt = () => {
    return Boolean(activePromptCollector && acpConnection && acpSessionId);
  };

  const cancelActiveAcpPrompt = async () => {
    try {
      if (acpConnection && acpSessionId) {
        await acpConnection.cancel({ sessionId: acpSessionId });
      }
    } catch (_) {
    }
  };

  const shutdownAcpRuntime = async (reason: string) => {
    const processToStop = geminiProcess;
    const runtimeSessionId = acpSessionId;

    activePromptCollector = null;
    acpConnection = null;
    acpSessionId = null;
    acpInitPromise = null;
    geminiProcess = null;
    geminiStderrTail = '';

    if (processToStop && !processToStop.killed && processToStop.exitCode === null) {
      await terminateProcessGracefully(processToStop, 'main-acp-runtime', {
        reason,
        sessionId: runtimeSessionId,
      });
    }
  };

  const buildGeminiAcpArgs = () => {
    const args = ['--experimental-acp'];

    const includeDirectorySet = new Set(includeDirectories);
    for (const includeDirectory of includeDirectorySet) {
      args.push('--include-directories', includeDirectory);
    }

    if (geminiApprovalMode) {
      args.push('--approval-mode', geminiApprovalMode);
    }

    if (geminiModel) {
      args.push('--model', geminiModel);
    }

    return args;
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

    if (acpConnection && acpSessionId && geminiProcess && !geminiProcess.killed) {
      return;
    }

    if (acpInitPromise) {
      await acpInitPromise;
      return;
    }

    acpInitPromise = (async () => {
      const args = buildGeminiAcpArgs();
      logInfo('Starting Gemini ACP process', { command: geminiCommand, args });
      geminiStderrTail = '';
      geminiProcess = spawn(geminiCommand, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd(),
      });

      geminiProcess.stderr.on('data', (chunk: Buffer) => {
        const rawText = chunk.toString();
        appendGeminiStderrTail(rawText);
        const text = rawText.trim();
        if (text) {
          console.error(`[gemini] ${text}`);
        }
        if (activePromptCollector) {
          activePromptCollector.onActivity();
        }
      });

      geminiProcess.on('error', (error: Error) => {
        console.error('Gemini ACP process error:', error.message);
        resetAcpRuntime();
      });

      geminiProcess.on('close', (code: number, signal: string) => {
        console.error(`Gemini ACP process closed (code=${code}, signal=${signal})`);
        resetAcpRuntime();
      });

      const input = Writable.toWeb(geminiProcess.stdin) as unknown as WritableStream<Uint8Array>;
      const output = Readable.toWeb(geminiProcess.stdout) as unknown as ReadableStream<Uint8Array>;
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
          mcpServers: [],
        });

        acpSessionId = session.sessionId;
        logInfo('ACP session ready', { sessionId: acpSessionId });
      } catch (error: any) {
        const baseMessage = getErrorMessage(error);
        const isInternalError = baseMessage.includes('Internal error');
        const hint = isInternalError
          ? 'Gemini ACP newSession returned Internal error. This is often caused by a local MCP server or skill initialization issue. Try launching `gemini` directly and checking MCP/skills diagnostics.'
          : '';

        logInfo('ACP initialization failed', {
          error: baseMessage,
          stderrTail: geminiStderrTail || '(empty)',
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
        logInfo('Gemini ACP prewarm complete');
      })
      .catch((error: unknown) => {
        logInfo('Gemini ACP prewarm failed', { error: getErrorMessage(error) });
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
    const promptInvocationId = `telegram-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    logInfo('Starting ACP prompt', {
      invocationId: promptInvocationId,
      sessionId: acpSessionId,
      promptLength: promptText.length,
    });
    const promptForGemini = buildPromptWithMemory(promptText);

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
          failOnce(new Error(`Gemini ACP produced no output for ${acpNoOutputTimeoutMs}ms`));
        }, acpNoOutputTimeoutMs);
      };

      const overallTimeout = setTimeout(async () => {
        await cancelActiveAcpPrompt();
        failOnce(new Error(`Gemini ACP timed out after ${acpTimeoutMs}ms`));
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
            } catch (_) {
            }
          }
        },
      };

      refreshNoOutputTimer();

      acpConnection.prompt({
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
              deliveryMode: 'telegram-live-preview-then-final',
            });
          }
          if (result?.stopReason === 'cancelled' && !fullResponse) {
            failOnce(new Error(manualAbortRequested ? 'Gemini ACP prompt was aborted by user' : 'Gemini ACP prompt was cancelled'));
            return;
          }
          resolveOnce(fullResponse || 'No response received.');
        })
        .catch((error: any) => {
          failOnce(new Error(error?.message || 'Gemini ACP prompt failed'));
        });
    });
  };

  return {
    buildGeminiAcpArgs,
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
      geminiProcessRunning: Boolean(geminiProcess && !geminiProcess.killed),
    }),
  };
}
