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
  onConversationComplete?: (userMessage: string, botResponse: string, chatId: string) => void;
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
  onConversationComplete,
}: ProcessSingleMessageParams) {
  logInfo('Starting message processing', {
    requestId: messageRequestId,
    chatId: messageContext.chatId,
  });

  const stopTypingIndicator = messageContext.startTyping();
  let liveMessageId: string | number | undefined;
  let previewBuffer = '';
  let flushTimer: NodeJS.Timeout | null = null;
  let lastFlushAt = Date.now();
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

  const flushPreview = async (force = false, allowStart = true) => {
    if (finalizedViaLiveMessage) {
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

    if (!liveMessageId) {
      if (!allowStart) {
        return;
      }

      if (startingLiveMessage) {
        await startingLiveMessage;
      } else {
        startingLiveMessage = (async () => {
          try {
            liveMessageId = await messageContext.startLiveMessage(text || '…');
          } catch (_) {
            liveMessageId = undefined;
          }
        })();

        try {
          await startingLiveMessage;
        } finally {
          startingLiveMessage = null;
        }
      }
    }

    if (!liveMessageId) {
      return;
    }

    try {
      await messageContext.updateLiveMessage(liveMessageId, text);
      if (acpDebugStream) {
        logInfo('Live preview updated', {
          requestId: messageRequestId,
          previewLength: text.length,
        });
      }
    } catch (error: any) {
      const errorMessage = getErrorMessage(error).toLowerCase();
      if (!errorMessage.includes('message is not modified')) {
        logInfo('Live preview update skipped', {
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

  const finalizeCurrentMessage = async () => {
    if (!liveMessageId) {
      return;
    }

    if (startingLiveMessage) {
      try {
        await startingLiveMessage;
      } catch (_) {}
    }

    clearFlushTimer();
    await flushPreview(true, false);

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
      void scheduleFlush();
    });
    promptCompleted = true;

    clearFlushTimer();
    await flushPreview(true);

    if (startingLiveMessage) {
      try {
        await startingLiveMessage;
      } catch (_) {}
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
      logInfo('Sending final response', {
        requestId: messageRequestId,
        responseLength: (fullResponse || '').length,
      });
    }

    if (!finalizedViaLiveMessage) {
      await messageContext.sendText(fullResponse || 'No response received.');
    }

    // Track conversation history after successful completion
    if (onConversationComplete && fullResponse) {
      try {
        onConversationComplete(messageContext.text, fullResponse, messageContext.chatId);
      } catch (error: any) {
        logInfo('Failed to track conversation history', {
          requestId: messageRequestId,
          error: getErrorMessage(error),
        });
      }
    }
  } finally {
    clearFlushTimer();
    if (liveMessageId && !finalizedViaLiveMessage && !promptCompleted) {
      try {
        await messageContext.removeMessage(liveMessageId);
      } catch (_) {}
    }

    stopTypingIndicator();
    logInfo('Finished message processing', {
      requestId: messageRequestId,
      chatId: messageContext.chatId,
    });
  }
}
