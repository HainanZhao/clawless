import { debounce } from 'lodash-es';

type LogInfoFn = (message: string, details?: unknown) => void;

type ProcessSingleMessageParams = {
  messageContext: any;
  messageRequestId: number;
  maxResponseLength: number;
  streamUpdateIntervalMs: number;
  messageGapThresholdMs: number;
  acpDebugStream: boolean;
  runAcpPrompt: (promptText: string, onChunk?: (chunk: string) => void) => Promise<string>;
  scheduleAsyncJob: (message: string, chatId: string) => Promise<void>;
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
  scheduleAsyncJob,
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
  let lastFlushAt = Date.now();
  let lastChunkAt = 0;
  let finalizedViaLiveMessage = false;
  let startingLiveMessage: Promise<void> | null = null;
  let promptCompleted = false;
  let modeDetected = false;
  let isAsyncMode = false;
  let prefixBuffer = '';
  const PREFIX_MAX_LEN = 20; // Enough to hold [MODE: QUICK] or [MODE: ASYNC]

  const previewText = () => {
    if (previewBuffer.length <= maxResponseLength) {
      return previewBuffer;
    }
    return `${previewBuffer.slice(0, maxResponseLength - 1)}…`;
  };

  const flushPreview = async (force = false, allowStart = true) => {
    if (finalizedViaLiveMessage || isAsyncMode || !modeDetected) {
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

  // Create a debounced flush function using lodash
  const debouncedFlush = debounce(
    async () => {
      await flushPreview(true);
    },
    streamUpdateIntervalMs,
    { leading: false, trailing: true },
  );

  const finalizeCurrentMessage = async () => {
    if (!liveMessageId || isAsyncMode || !modeDetected) {
      return;
    }

    if (startingLiveMessage) {
      try {
        await startingLiveMessage;
      } catch (_) {}
    }

    debouncedFlush.cancel();
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
    const smartPrompt = `[SYSTEM: HYBRID MODE]
Instructions:
1. Analyze the User Request below.
2. Determine if it is "Quick" (answer now) or "Async" (background task).
3. YOU MUST START YOUR RESPONSE WITH EXACTLY ONE OF THESE PREFIXES:
   - "[MODE: QUICK] " -> Followed immediately by your answer.
   - "[MODE: ASYNC] " -> Followed immediately by a brief confirmation message (e.g. "I'll start that background task...").

User Request: "${messageContext.text}"`;

    const fullResponse = await runAcpPrompt(smartPrompt, async (chunk) => {
      // If we already detected ASYNC mode, we suppress output (we'll handle it at the end)
      // But we still consume the stream to let the prompt finish.
      if (modeDetected && isAsyncMode) return;

      const now = Date.now();
      const gapSinceLastChunk = lastChunkAt > 0 ? now - lastChunkAt : 0;

      if (!modeDetected) {
        prefixBuffer += chunk;
        
        // Try to detect prefix
        if (prefixBuffer.includes('[MODE: QUICK]')) {
          modeDetected = true;
          isAsyncMode = false;
          // Strip the prefix and any leading whitespace from the buffer
          const content = prefixBuffer.replace(/\[MODE: QUICK\]\s*/, '');
          previewBuffer += content;
        } else if (prefixBuffer.includes('[MODE: ASYNC]')) {
          modeDetected = true;
          isAsyncMode = true;
          // We don't update previewBuffer for ASYNC because we handle it separately
        } else if (prefixBuffer.length > PREFIX_MAX_LEN) {
           // Fallback: If we exceeded max length without a valid prefix, assume QUICK (legacy/fallback behavior)
           // and just dump the whole buffer as content.
           modeDetected = true;
           isAsyncMode = false;
           previewBuffer += prefixBuffer;
           logInfo('No valid mode prefix detected, falling back to QUICK', { requestId: messageRequestId });
        }
        
        // If we just switched to QUICK mode, we might have content to flush
        if (modeDetected && !isAsyncMode) {
             void debouncedFlush();
        }
        return;
      }

      // Normal streaming for QUICK mode
      if (gapSinceLastChunk > messageGapThresholdMs && liveMessageId && previewBuffer.trim()) {
        await finalizeCurrentMessage();
      }

      lastChunkAt = now;
      previewBuffer += chunk;
      void debouncedFlush();
    });
    promptCompleted = true;

    // Handle edge case where the entire response came in one chunk or small enough to handle at end
    if (!modeDetected) {
        if (prefixBuffer.includes('[MODE: ASYNC]')) {
            isAsyncMode = true;
        } else {
            // Assume Quick
            // Strip any partial prefix if it exists? No, just use raw.
            // Actually let's try to clean it if it matches our pattern
             const content = prefixBuffer.replace(/\[MODE: QUICK\]\s*/, '');
             previewBuffer = content;
        }
        modeDetected = true;
    }

    if (isAsyncMode) {
      logInfo('Async mode detected, scheduling background job', { requestId: messageRequestId });
      // Schedule the original user request, not the agent's confirmation message
      await scheduleAsyncJob(messageContext.text, messageContext.chatId);
      await messageContext.sendText("I've scheduled this as a background task. I'll notify you when it's done.");
      return;
    }

    // Normal completion for QUICK mode
    debouncedFlush.cancel();
    await flushPreview(true);

    if (startingLiveMessage) {
      try {
        await startingLiveMessage;
      } catch (_) {}
    }

    if (liveMessageId) {
      try {
        // Use previewBuffer here because fullResponse contains the raw text with prefix
        await messageContext.finalizeLiveMessage(liveMessageId, previewBuffer || 'No response received.');
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
        responseLength: (previewBuffer || '').length,
      });
    }

    if (!finalizedViaLiveMessage) {
      await messageContext.sendText(previewBuffer || 'No response received.');
    }

    // Track conversation history after successful completion
    if (onConversationComplete && previewBuffer) {
      try {
        onConversationComplete(messageContext.text, previewBuffer, messageContext.chatId);
      } catch (error: any) {
        logInfo('Failed to track conversation history', {
          requestId: messageRequestId,
          error: getErrorMessage(error),
        });
      }
    }
  } finally {
    debouncedFlush.cancel();
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
