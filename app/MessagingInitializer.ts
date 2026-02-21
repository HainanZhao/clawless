import path from 'node:path';
import { TelegramMessagingClient } from '../messaging/telegramClient.js';
import { SlackMessagingClient } from '../messaging/slackClient.js';
import { processSingleTelegramMessage } from '../messaging/liveMessageProcessor.js';
import { createMessageQueueProcessor } from '../messaging/messageQueue.js';
import { registerTelegramHandlers } from '../messaging/registerTelegramHandlers.js';
import { parseAllowlistFromEnv, parseWhitelistFromEnv } from '../utils/telegramWhitelist.js';
import { getErrorMessage, logInfo } from '../utils/error.js';
import { persistCallbackChatId, ensureClawlessHomeDirectory } from '../utils/callbackState.js';
import type { Config } from '../utils/config.js';
import type { AcpRuntime } from '../acp/runtimeManager.js';
import type { CronScheduler } from '../scheduler/cronScheduler.js';
import { appendConversationEntry, type ConversationHistoryConfig } from '../utils/conversationHistory.js';
import type { SemanticConversationMemory } from '../utils/semanticConversationMemory.js';

export type MessagingClient = TelegramMessagingClient | SlackMessagingClient;

export interface MessagingInitializerOptions {
  config: Config;
  acpRuntime: AcpRuntime;
  cronScheduler: CronScheduler;
  semanticConversationMemory: SemanticConversationMemory;
  conversationHistoryConfig: ConversationHistoryConfig;
  onChatBound: (chatId: string) => void;
}

export class MessagingInitializer {
  private config: Config;
  private messagingClient: MessagingClient;
  private enqueueMessage: (messageContext: any) => Promise<void>;
  private getQueueLength: () => number;

  constructor(options: MessagingInitializerOptions) {
    this.config = options.config;

    const TELEGRAM_WHITELIST = parseWhitelistFromEnv(this.config.TELEGRAM_WHITELIST);
    const SLACK_WHITELIST = parseAllowlistFromEnv(this.config.SLACK_WHITELIST, 'SLACK_WHITELIST');
    if (this.config.MESSAGING_PLATFORM === 'telegram') {
      if (TELEGRAM_WHITELIST.length === 0) {
        console.error('Error: TELEGRAM_WHITELIST is required in Telegram mode.');
        process.exit(1);
      }
      this.messagingClient = new TelegramMessagingClient({
        token: this.config.TELEGRAM_TOKEN || '',
        typingIntervalMs: this.config.TYPING_INTERVAL_MS,
        maxMessageLength: this.config.MAX_RESPONSE_LENGTH,
      });
    } else {
      if (SLACK_WHITELIST.length === 0) {
        console.error('Error: SLACK_WHITELIST is required in Slack mode.');
        process.exit(1);
      }
      this.messagingClient = new SlackMessagingClient({
        token: this.config.SLACK_BOT_TOKEN || '',
        signingSecret: this.config.SLACK_SIGNING_SECRET || '',
        appToken: this.config.SLACK_APP_TOKEN,
        typingIntervalMs: this.config.TYPING_INTERVAL_MS,
        maxMessageLength: this.config.MAX_RESPONSE_LENGTH,
      });
    }

    const ACTIVE_USER_WHITELIST = this.config.MESSAGING_PLATFORM === 'telegram' ? TELEGRAM_WHITELIST : SLACK_WHITELIST;

    const { enqueueMessage, getQueueLength } = createMessageQueueProcessor({
      processSingleMessage: (messageContext, messageRequestId) => {
        return processSingleTelegramMessage({
          messageContext,
          messageRequestId,
          maxResponseLength: this.config.MAX_RESPONSE_LENGTH,
          streamUpdateIntervalMs: this.config.STREAM_UPDATE_INTERVAL_MS,
          messageGapThresholdMs: 15000,
          acpDebugStream: this.config.ACP_DEBUG_STREAM,
          runAcpPrompt: options.acpRuntime.runAcpPrompt,
          scheduleAsyncJob: async (message, chatId, jobRef) => {
            return await options.cronScheduler.executeOneTimeJobImmediately(message, jobRef || 'Async User Task', {
              chatId,
            });
          },
          logInfo,
          getErrorMessage,
          onConversationComplete: this.config.CONVERSATION_HISTORY_ENABLED
            ? (userMessage, botResponse, chatId) => {
                const appendedEntry = appendConversationEntry(options.conversationHistoryConfig, {
                  chatId,
                  userMessage,
                  botResponse,
                  platform: this.config.MESSAGING_PLATFORM,
                });

                if (appendedEntry && options.semanticConversationMemory.isEnabled) {
                  void options.semanticConversationMemory.indexEntry(appendedEntry);
                }
              }
            : undefined,
        });
      },
      logInfo,
      getErrorMessage,
    });

    this.enqueueMessage = enqueueMessage;
    this.getQueueLength = getQueueLength;

    registerTelegramHandlers({
      messagingClient: this.messagingClient,
      telegramWhitelist: ACTIVE_USER_WHITELIST,
      enforceWhitelist: true,
      hasActiveAcpPrompt: options.acpRuntime.hasActiveAcpPrompt,
      cancelActiveAcpPrompt: options.acpRuntime.cancelActiveAcpPrompt,
      enqueueMessage: this.enqueueMessage,
      onAbortRequested: options.acpRuntime.requestManualAbort,
      onChatBound: (chatId) => {
        const CALLBACK_CHAT_STATE_FILE_PATH = path.join(this.config.CLAWLESS_HOME, 'callback-chat-state.json');
        persistCallbackChatId(
          CALLBACK_CHAT_STATE_FILE_PATH,
          chatId,
          () => ensureClawlessHomeDirectory(this.config.CLAWLESS_HOME),
          logInfo,
        );
        options.onChatBound(chatId);
      },
    });
  }

  public getMessagingClient(): MessagingClient {
    return this.messagingClient;
  }

  public getEnqueueMessage(): (messageContext: any) => Promise<void> {
    return this.enqueueMessage;
  }

  public getQueueLengthValue(): number {
    return this.getQueueLength();
  }

  public async launch(): Promise<void> {
    await this.messagingClient.launch();
  }

  public stop(signal: string): void {
    this.messagingClient.stop(signal);
  }
}
