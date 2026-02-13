import { Telegraf } from 'telegraf';

function splitTextIntoChunks(text: string, maxMessageLength: number): string[] {
  const normalizedText = String(text || '');
  if (!normalizedText) {
    return [''];
  }

  if (normalizedText.length <= maxMessageLength) {
    return [normalizedText];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < normalizedText.length) {
    const end = Math.min(start + maxMessageLength, normalizedText.length);
    chunks.push(normalizedText.slice(start, end));
    start = end;
  }

  return chunks;
}

class TelegramMessageContext {
  ctx: any;
  typingIntervalMs: number;
  maxMessageLength: number;
  text: string;
  chatId: string | number | undefined;

  constructor(ctx: any, typingIntervalMs: number, maxMessageLength: number) {
    this.ctx = ctx;
    this.typingIntervalMs = typingIntervalMs;
    this.maxMessageLength = maxMessageLength;
    this.text = ctx.message?.text || '';
    this.chatId = ctx.chat?.id;
  }

  startTyping() {
    this.ctx.telegram.sendChatAction(this.ctx.chat.id, 'typing').catch(() => {});

    const intervalId = setInterval(() => {
      this.ctx.telegram.sendChatAction(this.ctx.chat.id, 'typing').catch(() => {});
    }, this.typingIntervalMs);

    return () => clearInterval(intervalId);
  }

  async sendText(text: string) {
    const chunks = splitTextIntoChunks(text, this.maxMessageLength);
    for (const chunk of chunks) {
      await this.ctx.reply(chunk);
    }
  }

  async startLiveMessage(initialText = '…') {
    const sent = await this.ctx.reply(initialText);
    return sent?.message_id as number | undefined;
  }

  async updateLiveMessage(messageId: number, text: string) {
    await this.ctx.telegram.editMessageText(this.ctx.chat.id, messageId, undefined, text || '…');
  }

  async finalizeLiveMessage(messageId: number, text: string) {
    const finalText = text || 'No response received.';
    const chunks = splitTextIntoChunks(finalText, this.maxMessageLength);

    try {
      await this.updateLiveMessage(messageId, chunks[0] || 'No response received.');
    } catch (error: any) {
      const errorMessage = String(error?.message || '').toLowerCase();
      if (!errorMessage.includes('message is not modified')) {
        throw error;
      }
    }

    for (let index = 1; index < chunks.length; index += 1) {
      await this.ctx.reply(chunks[index]);
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

  constructor({ token, typingIntervalMs, maxMessageLength }: { token: string; typingIntervalMs: number; maxMessageLength: number }) {
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
    const chunks = splitTextIntoChunks(text, this.maxMessageLength);
    for (const chunk of chunks) {
      await this.bot.telegram.sendMessage(chatId, chunk);
    }
  }

  stop(reason: string) {
    this.bot.stop(reason);
  }
}