import { debounce } from 'lodash-es';
import { generateShortId } from '../utils/commandText.js';
import { detectConversationMode, wrapHybridPrompt, ConversationMode } from './ModeDetector.js';

type LogInfoFn = (message: string, details?: unknown) => void;

type ProcessSingleMessageParams = {
  messageContext: any;
  messageRequestId: number;
  maxResponseLength: number;
  streamUpdateIntervalMs: number;
  messageGapThresholdMs: number;
  acpDebugStream: boolean;
  runAcpPrompt: (promptText: string, onChunk?: (chunk: string) => void) => Promise<string>;
  scheduleAsyncJob: (message: string, chatId: string, jobRef: string) => Promise<string>;
  logInfo: LogInfoFn;
  getErrorMessage: (error: unknown, fallbackMessage?: string) => string;
  onConversationComplete?: (userMessage: string, botResponse: string, chatId: string) => void;
};

/**
 * Manages the lifecycle of a "live" streaming message on the chat platform.
 */
class LiveMessageManager {
  private liveMessageId: string | number | undefined;
  private previewBuffer = '';
  private lastFlushAt = 0;
  private finalized = false;
  private startingLiveMessage: Promise<void> | null = null;
  private debouncedFlush: ReturnType<typeof debounce>;

  constructor(
    private readonly messageContext: any,
    private readonly requestId: number,
    private readonly maxResponseLength: number,
    private readonly streamUpdateIntervalMs: number,
    private readonly logInfo: LogInfoFn,
    private readonly getErrorMessage: (error: unknown) => string,
    private readonly acpDebugStream: boolean,
  ) {
    this.debouncedFlush = debounce(
      async () => {
        await this.flushPreview(true);
      },
      this.streamUpdateIntervalMs,
      { leading: false, trailing: true },
    );
  }

  append(chunk: string) {
    this.previewBuffer += chunk;
    void this.debouncedFlush();
  }

  getBuffer() {
    return this.previewBuffer;
  }

  setBuffer(text: string) {
    this.previewBuffer = text;
  }

  private getPreviewText() {
    if (this.previewBuffer.length <= this.maxResponseLength) {
      return this.previewBuffer;
    }
    return `${this.previewBuffer.slice(0, this.maxResponseLength - 1)}…`;
  }

  async flushPreview(force = false, allowStart = true) {
    if (this.finalized) return;

    const now = Date.now();
    if (!force && now - this.lastFlushAt < this.streamUpdateIntervalMs) {
      return;
    }

    this.lastFlushAt = now;
    const text = this.getPreviewText();
    if (!text) return;

    if (!this.liveMessageId) {
      if (!allowStart) return;

      if (this.startingLiveMessage) {
        await this.startingLiveMessage;
      } else {
        this.startingLiveMessage = (async () => {
          try {
            this.liveMessageId = await this.messageContext.startLiveMessage(text || '…');
          } catch (_) {
            this.liveMessageId = undefined;
          }
        })();

        try {
          await this.startingLiveMessage;
        } finally {
          this.startingLiveMessage = null;
        }
      }
    }

    if (!this.liveMessageId) return;

    try {
      await this.messageContext.updateLiveMessage(this.liveMessageId, text);
      if (this.acpDebugStream) {
        this.logInfo('Live preview updated', {
          requestId: this.requestId,
          previewLength: text.length,
        });
      }
    } catch (error: any) {
      const errorMessage = this.getErrorMessage(error).toLowerCase();
      if (!errorMessage.includes('message is not modified')) {
        this.logInfo('Live preview update skipped', {
          requestId: this.requestId,
          error: this.getErrorMessage(error),
        });
      }
    }
  }

  async finalize(textOverride?: string) {
    if (this.finalized) return;

    this.debouncedFlush.cancel();
    await this.flushPreview(true, false);

    if (!this.liveMessageId) return;

    try {
      const text = textOverride || this.getPreviewText();
      await this.messageContext.finalizeLiveMessage(this.liveMessageId, text);
      this.finalized = true;
      if (this.acpDebugStream) {
        this.logInfo('Finalized live message', {
          requestId: this.requestId,
          messageLength: text.length,
        });
      }
    } catch (error: any) {
      this.logInfo('Failed to finalize live message', {
        requestId: this.requestId,
        error: this.getErrorMessage(error),
      });
    }
  }

  async cleanup(success: boolean) {
    this.debouncedFlush.cancel();
    if (this.liveMessageId && !this.finalized && !success) {
      try {
        await this.messageContext.removeMessage(this.liveMessageId);
      } catch (_) {}
    }
  }

  isLive() {
    return !!this.liveMessageId;
  }

  isFinalized() {
    return this.finalized;
  }
}

export async function processSingleTelegramMessage(params: ProcessSingleMessageParams) {
  const {
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
  } = params;

  logInfo('Starting message processing', {
    requestId: messageRequestId,
    chatId: messageContext.chatId,
  });

  const stopTypingIndicator = messageContext.startTyping();
  const liveMessage = new LiveMessageManager(
    messageContext,
    messageRequestId,
    maxResponseLength,
    streamUpdateIntervalMs,
    logInfo,
    getErrorMessage,
    acpDebugStream,
  );

  let lastChunkAt = 0;
  let promptCompleted = false;
  const modeDetected = !!messageContext.skipHybridMode;
  let conversationMode = modeDetected ? ConversationMode.QUICK : ConversationMode.UNKNOWN;
  let prefixBuffer = '';

  if (modeDetected) {
    logInfo('Mode detection skipped due to skipHybridMode flag', { requestId: messageRequestId });
  }

  try {
    const prompt = modeDetected ? messageContext.text : wrapHybridPrompt(messageContext.text);

    const fullResponse = await runAcpPrompt(prompt, async (chunk) => {
      // If we already detected ASYNC mode, we suppress output (handled at end)
      if (conversationMode === ConversationMode.ASYNC) return;

      const now = Date.now();
      const gapSinceLastChunk = lastChunkAt > 0 ? now - lastChunkAt : 0;

      if (conversationMode === ConversationMode.UNKNOWN) {
        prefixBuffer += chunk;
        const result = detectConversationMode(prefixBuffer);

        if (result.isDetected) {
          conversationMode = result.mode;
          logInfo('Mode detected via streaming', { requestId: messageRequestId, mode: conversationMode });

          if (conversationMode === ConversationMode.QUICK) {
            liveMessage.append(result.content);
          }
        }
        return;
      }

      // Normal streaming for QUICK mode
      if (gapSinceLastChunk > messageGapThresholdMs && liveMessage.isLive() && liveMessage.getBuffer().trim()) {
        await liveMessage.finalize();
      }

      lastChunkAt = now;
      liveMessage.append(chunk);
    });

    promptCompleted = true;

    // Handle edge case where detection didn't happen in stream
    if (conversationMode === ConversationMode.UNKNOWN) {
      const result = detectConversationMode(fullResponse);
      conversationMode = result.isDetected ? result.mode : ConversationMode.QUICK;
      if (conversationMode === ConversationMode.QUICK) {
        liveMessage.setBuffer(result.content);
      }

      if (!result.isDetected) {
        logInfo('No mode prefix detected, defaulting to QUICK', { requestId: messageRequestId });
      }
    }

    if (conversationMode === ConversationMode.ASYNC) {
      const jobRef = `job_${generateShortId()}`;
      logInfo('Async mode confirmed, scheduling background job', { requestId: messageRequestId, jobRef });

      const taskMessage = detectConversationMode(fullResponse).content || messageContext.text;
      void scheduleAsyncJob(taskMessage, messageContext.chatId, jobRef).catch((error) => {
        logInfo('Fire-and-forget scheduleAsyncJob failed', {
          requestId: messageRequestId,
          jobRef,
          error: getErrorMessage(error),
        });
      });

      const finalMsg = `[MODE: ASYNC] I've scheduled this task. I'll notify you when it's done. Reference: ${jobRef}`;
      await messageContext.sendText(finalMsg);
      return;
    }

    // Completion for QUICK mode
    await liveMessage.finalize();

    if (!liveMessage.isFinalized()) {
      const response = liveMessage.getBuffer() || 'No response received.';
      await messageContext.sendText(response);
    }

    if (onConversationComplete && liveMessage.getBuffer()) {
      try {
        onConversationComplete(messageContext.text, liveMessage.getBuffer(), messageContext.chatId);
      } catch (error: any) {
        logInfo('Failed to track conversation history', { requestId: messageRequestId, error: getErrorMessage(error) });
      }
    }
  } finally {
    await liveMessage.cleanup(promptCompleted);
    stopTypingIndicator();
    logInfo('Finished message processing', {
      requestId: messageRequestId,
      chatId: messageContext.chatId,
    });
  }
}
