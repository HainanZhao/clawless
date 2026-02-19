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
  let lastFlushAt = 0;
  let startingLiveMessage: Promise<void> | null = null;
  let promptCompleted = false;
  let anyMessageStarted = false;

  const clearTimer = () => {
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

  const flushPreview = async (isFinal = false) => {
    const text = previewText();
    if (!text && !isFinal) {
      return;
    }

    lastFlushAt = Date.now();

    if (!liveMessageId) {
      if (startingLiveMessage) {
        await startingLiveMessage;
      } else {
        startingLiveMessage = (async () => {
          try {
            liveMessageId = await messageContext.startLiveMessage(text || '…');
            anyMessageStarted = true;
          } catch (error: any) {
            logInfo('Failed to start live message', {
              requestId: messageRequestId,
              error: getErrorMessage(error),
            });
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
      if (isFinal && (text || !anyMessageStarted)) {
        await messageContext.sendText(text || 'No response received.');
        anyMessageStarted = true;
        previewBuffer = '';
      }
      return;
    }

    try {
      if (isFinal) {
        await messageContext.finalizeLiveMessage(liveMessageId, text || 'No response received.');
        liveMessageId = undefined;
        previewBuffer = '';
      } else if (text) {
        await messageContext.updateLiveMessage(liveMessageId, text);
        if (acpDebugStream) {
          logInfo('Live preview updated', {
            requestId: messageRequestId,
            previewLength: text.length,
          });
        }
      }
    } catch (error: any) {
      const errorMessage = getErrorMessage(error).toLowerCase();
      if (!errorMessage.includes('message is not modified')) {
        logInfo('Live preview update failed', {
          requestId: messageRequestId,
          error: getErrorMessage(error),
        });
      }
    }
  };

  try {
    const fullResponse = await runAcpPrompt(messageContext.text, async (chunk) => {
      previewBuffer += chunk;
      const now = Date.now();

      // Periodic live update (no timer needed)
      if (now - lastFlushAt >= streamUpdateIntervalMs) {
        void flushPreview(false);
      }

      // Single debounce timer for gap/finalization
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushPreview(true);
      }, messageGapThresholdMs);
    });
    promptCompleted = true;

    clearTimer();

    // Fallback for non-streaming response
    if (!anyMessageStarted && !previewBuffer && fullResponse) {
      previewBuffer = fullResponse;
    }

    await flushPreview(true);

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
    clearTimer();
    if (liveMessageId && !promptCompleted) {
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
