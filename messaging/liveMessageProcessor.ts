type LogInfoFn = (message: string, details?: unknown) => void;

type ProcessSingleMessageParams = {
  messageContext: any;
  messageRequestId: number;
  maxResponseLength: number;
  streamUpdateIntervalMs: number;
  messageGapThresholdMs: number;
  acpDebugStream: boolean;
  runAcpPrompt: (promptText: string, onChunk?: (chunk: string) => void) => Promise<string>;
  logInfo: LogInfoFn;
  getErrorMessage: (error: unknown, fallbackMessage?: string) => string;
};

export async function processSingleTelegramMessage({
  messageContext,
  messageRequestId,
  maxResponseLength,
  streamUpdateIntervalMs,
  messageGapThresholdMs,
  acpDebugStream,
  runAcpPrompt,
  logInfo,
  getErrorMessage,
}: ProcessSingleMessageParams) {
  logInfo('Starting Telegram message processing', {
    requestId: messageRequestId,
    chatId: messageContext.chatId,
  });

  const stopTypingIndicator = messageContext.startTyping();
  let liveMessageId: number | undefined;
  let previewBuffer = '';
  let flushTimer: NodeJS.Timeout | null = null;
  let lastFlushAt = 0;
  let lastChunkAt = 0;
  let finalizedViaLiveMessage = false;
  let startingLiveMessage: Promise<void> | null = null;
  let promptCompleted = false;

  const clearFlushTimer = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const previewText = () => {
    if (previewBuffer.length <= maxResponseLength) {
      return previewBuffer;
    }
    return `${previewBuffer.slice(0, maxResponseLength - 1)}…`;
  };

  const flushPreview = async (force = false) => {
    if (!liveMessageId || finalizedViaLiveMessage) {
      return;
    }

    const now = Date.now();
    if (!force && now - lastFlushAt < streamUpdateIntervalMs) {
      return;
    }

    lastFlushAt = now;
    const text = previewText();
    if (!text) {
      return;
    }

    try {
      await messageContext.updateLiveMessage(liveMessageId, text);
      if (acpDebugStream) {
        logInfo('Telegram live preview updated', {
          requestId: messageRequestId,
          previewLength: text.length,
        });
      }
    } catch (error: any) {
      const errorMessage = getErrorMessage(error).toLowerCase();
      if (!errorMessage.includes('message is not modified')) {
        logInfo('Telegram live preview update skipped', {
          requestId: messageRequestId,
          error: getErrorMessage(error),
        });
      }
    }
  };

  const scheduleFlush = () => {
    if (flushTimer) {
      return;
    }

    const dueIn = Math.max(0, streamUpdateIntervalMs - (Date.now() - lastFlushAt));
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await flushPreview(true);
    }, dueIn);
  };

  const ensureLiveMessageStarted = async () => {
    if (liveMessageId || finalizedViaLiveMessage) {
      return;
    }

    if (startingLiveMessage) {
      await startingLiveMessage;
      return;
    }

    startingLiveMessage = (async () => {
      try {
        const initialPreview = previewText() || '…';
        liveMessageId = await messageContext.startLiveMessage(initialPreview);
        lastFlushAt = Date.now();
      } catch (_) {
        liveMessageId = undefined;
      }
    })();

    try {
      await startingLiveMessage;
    } finally {
      startingLiveMessage = null;
    }
  };

  const finalizeCurrentMessage = async () => {
    if (!liveMessageId) {
      return;
    }

    if (startingLiveMessage) {
      try {
        await startingLiveMessage;
      } catch (_) {
      }
    }

    clearFlushTimer();
    await flushPreview(true);

    try {
      const text = previewText();
      await messageContext.finalizeLiveMessage(liveMessageId, text);
      if (acpDebugStream) {
        logInfo('Finalized message due to long gap', {
          requestId: messageRequestId,
          messageLength: text.length,
        });
      }
    } catch (error: any) {
      logInfo('Failed to finalize message on gap', {
        requestId: messageRequestId,
        error: getErrorMessage(error),
      });
    }

    liveMessageId = undefined;
    previewBuffer = '';
    lastFlushAt = Date.now();
    startingLiveMessage = null;
  };

  try {
    const fullResponse = await runAcpPrompt(messageContext.text, async (chunk) => {
      const now = Date.now();
      const gapSinceLastChunk = lastChunkAt > 0 ? now - lastChunkAt : 0;

      if (gapSinceLastChunk > messageGapThresholdMs && liveMessageId && previewBuffer.trim()) {
        await finalizeCurrentMessage();
      }

      lastChunkAt = now;
      previewBuffer += chunk;
      void ensureLiveMessageStarted();
      void scheduleFlush();
    });
    promptCompleted = true;

    clearFlushTimer();
    await flushPreview(true);

    if (startingLiveMessage) {
      try {
        await startingLiveMessage;
      } catch (_) {
      }
    }

    if (liveMessageId) {
      try {
        await messageContext.finalizeLiveMessage(liveMessageId, fullResponse || 'No response received.');
        finalizedViaLiveMessage = true;
      } catch (error: any) {
        finalizedViaLiveMessage = true;
        logInfo('Live message finalize failed; keeping streamed message as final output', {
          requestId: messageRequestId,
          error: getErrorMessage(error),
        });
      }
    }

    if (!finalizedViaLiveMessage && acpDebugStream) {
      logInfo('Sending Telegram final response', {
        requestId: messageRequestId,
        responseLength: (fullResponse || '').length,
      });
    }

    if (!finalizedViaLiveMessage) {
      await messageContext.sendText(fullResponse || 'No response received.');
    }
  } finally {
    clearFlushTimer();
    if (liveMessageId && !finalizedViaLiveMessage && !promptCompleted) {
      try {
        await messageContext.removeMessage(liveMessageId);
      } catch (_) {
      }
    }

    stopTypingIndicator();
    logInfo('Finished Telegram message processing', {
      requestId: messageRequestId,
      chatId: messageContext.chatId,
    });
  }
}
