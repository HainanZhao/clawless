import { Telegraf } from 'telegraf';
import telegramifyMarkdown from 'telegramify-markdown';
import { splitIntoSmartChunks } from './messageTruncator.js';

const TELEGRAM_PARSE_MODE = 'MarkdownV2' as const;

/**
 * Escapes characters that are reserved in Telegram's MarkdownV2.
 * Used as a fallback when Markdown conversion fails or for plain text components.
 * See: https://core.telegram.org/bots/api#markdownv2-style
 */
export function escapeMarkdownV2(text: string): string {
  return String(text || '').replace(/[\\_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

export function toTelegramMarkdown(text: string): string {
  const normalizedText = String(text || '');
  if (!normalizedText) {
    return normalizedText;
  }

  try {
    return telegramifyMarkdown(normalizedText, 'escape');
  } catch {
    return escapeMarkdownV2(normalizedText);
  }
}

class TelegramMessageContext {
  ctx: any;
  typingIntervalMs: number;
  maxMessageLength: number;
  text: string;
  chatId: string | number | undefined;
  userId: number | undefined;
  username: string | undefined;

  constructor(ctx: any, typingIntervalMs: number, maxMessageLength: number) {
    this.ctx = ctx;
    this.typingIntervalMs = typingIntervalMs;
    this.maxMessageLength = maxMessageLength;
    this.text = ctx.message?.text || '';
    this.chatId = ctx.chat?.id;
    this.userId = ctx.from?.id;
    this.username = ctx.from?.username;
  }

  startTyping() {
    this.ctx.telegram.sendChatAction(this.ctx.chat.id, 'typing').catch(() => {});

    const intervalId = setInterval(() => {
      this.ctx.telegram.sendChatAction(this.ctx.chat.id, 'typing').catch(() => {});
    }, this.typingIntervalMs);

    return () => clearInterval(intervalId);
  }

  async sendText(text: string) {
    const chunks = splitIntoSmartChunks(text, this.maxMessageLength);
    for (const chunk of chunks) {
      try {
        const formattedChunk = toTelegramMarkdown(chunk);
        await this.ctx.reply(formattedChunk, { parse_mode: TELEGRAM_PARSE_MODE });
      } catch (error: any) {
        const errorMessage = String(error?.message || '').toLowerCase();
        if (errorMessage.includes('reserved') || errorMessage.includes('parse entities')) {
          await this.ctx.reply(escapeMarkdownV2(chunk), { parse_mode: TELEGRAM_PARSE_MODE });
        } else {
          throw error;
        }
      }
    }
  }

  async startLiveMessage(initialText = '…') {
    const formattedText = toTelegramMarkdown(initialText || '…');
    const sent = await this.ctx.reply(formattedText, { parse_mode: TELEGRAM_PARSE_MODE });
    return sent?.message_id as number | undefined;
  }

  async updateLiveMessage(messageId: number, text: string) {
    const formattedText = toTelegramMarkdown(text || '…');
    try {
      await this.ctx.telegram.editMessageText(this.ctx.chat.id, messageId, undefined, formattedText, {
        parse_mode: TELEGRAM_PARSE_MODE,
      });
    } catch (error: any) {
       const errorMessage = String(error?.message || '').toLowerCase();
       if (errorMessage.includes('reserved') || errorMessage.includes('parse entities')) {
          await this.ctx.telegram.editMessageText(this.ctx.chat.id, messageId, undefined, escapeMarkdownV2(text || '…'), {
            parse_mode: TELEGRAM_PARSE_MODE,
          });
       }
    }
  }

  async finalizeLiveMessage(messageId: number, text: string) {
    const defaultResponse = 'No response received.';
    const finalText = text || defaultResponse;
    const rawChunks = splitIntoSmartChunks(finalText, this.maxMessageLength);
    const formattedChunks = rawChunks.map((c) => toTelegramMarkdown(c));

    try {
      await this.ctx.telegram.editMessageText(
        this.ctx.chat.id,
        messageId,
        undefined,
        formattedChunks[0] || toTelegramMarkdown(defaultResponse),
        {
          parse_mode: TELEGRAM_PARSE_MODE,
        },
      );
    } catch (error: any) {
      const errorMessage = String(error?.message || '').toLowerCase();
      if (errorMessage.includes('message is not modified')) {
        // ignore
      } else if (errorMessage.includes('reserved') || errorMessage.includes('parse entities')) {
        await this.ctx.telegram.editMessageText(
          this.ctx.chat.id,
          messageId,
          undefined,
          escapeMarkdownV2(rawChunks[0] || defaultResponse),
          { parse_mode: TELEGRAM_PARSE_MODE },
        );
      } else {
        throw error;
      }
    }

    for (let index = 1; index < formattedChunks.length; index += 1) {
      try {
        await this.ctx.reply(formattedChunks[index], { parse_mode: TELEGRAM_PARSE_MODE });
      } catch (error: any) {
        const errorMessage = String(error?.message || '').toLowerCase();
        if (errorMessage.includes('reserved') || errorMessage.includes('parse entities')) {
          await this.ctx.reply(escapeMarkdownV2(rawChunks[index]), { parse_mode: TELEGRAM_PARSE_MODE });
        } else {
          throw error;
        }
      }
    }
  }

  async removeMessage(messageId: number) {
    await this.ctx.telegram.deleteMessage(this.ctx.chat.id, messageId);
  }
}

export class TelegramMessagingClient {
  bot: Telegraf;
  typingIntervalMs: number;
  maxMessageLength: number;

  constructor({
    token,
    typingIntervalMs,
    maxMessageLength,
  }: { token: string; typingIntervalMs: number; maxMessageLength: number }) {
    this.bot = new Telegraf(token);
    this.typingIntervalMs = typingIntervalMs;
    this.maxMessageLength = maxMessageLength;
  }

  onTextMessage(handler: (messageContext: TelegramMessageContext) => Promise<void> | void) {
    this.bot.on('text', (ctx) => {
      const messageContext = new TelegramMessageContext(ctx, this.typingIntervalMs, this.maxMessageLength);
      Promise.resolve(handler(messageContext)).catch((error) => {
        console.error('Text message handler failed:', error);
      });
    });
  }

  onError(handler: (error: Error, messageContext: TelegramMessageContext | null) => void) {
    this.bot.catch((error, ctx) => {
      const messageContext = ctx?.chat
        ? new TelegramMessageContext(ctx, this.typingIntervalMs, this.maxMessageLength)
        : null;
      handler(error as Error, messageContext);
    });
  }

  async launch() {
    await this.bot.launch();
  }

  async sendTextToChat(chatId: string | number, text: string) {
    const chunks = splitIntoSmartChunks(text, this.maxMessageLength);
    for (const chunk of chunks) {
      try {
        const formattedChunk = toTelegramMarkdown(chunk);
        await this.bot.telegram.sendMessage(chatId, formattedChunk, { parse_mode: TELEGRAM_PARSE_MODE });
      } catch (error: any) {
        const errorMessage = String(error?.message || '').toLowerCase();
        if (errorMessage.includes('reserved') || errorMessage.includes('parse entities')) {
          await this.bot.telegram.sendMessage(chatId, escapeMarkdownV2(chunk), { parse_mode: TELEGRAM_PARSE_MODE });
        } else {
          throw error;
        }
      }
    }
  }

  stop(reason: string) {
    this.bot.stop(reason);
  }
}
