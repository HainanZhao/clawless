import { Telegraf } from 'telegraf';

class TelegramMessageContext {
  ctx: any;
  typingIntervalMs: number;
  text: string;
  chatId: string | number | undefined;

  constructor(ctx: any, typingIntervalMs: number) {
    this.ctx = ctx;
    this.typingIntervalMs = typingIntervalMs;
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
    await this.ctx.reply(text);
  }
}

export class TelegramMessagingClient {
  bot: Telegraf;
  typingIntervalMs: number;

  constructor({ token, typingIntervalMs }: { token: string; typingIntervalMs: number }) {
    this.bot = new Telegraf(token);
    this.typingIntervalMs = typingIntervalMs;
  }

  onTextMessage(handler: (messageContext: TelegramMessageContext) => Promise<void> | void) {
    this.bot.on('text', (ctx) => {
      const messageContext = new TelegramMessageContext(ctx, this.typingIntervalMs);
      Promise.resolve(handler(messageContext)).catch((error) => {
        console.error('Text message handler failed:', error);
      });
    });
  }

  onError(handler: (error: Error, messageContext: TelegramMessageContext | null) => void) {
    this.bot.catch((error, ctx) => {
      const messageContext = ctx?.chat
        ? new TelegramMessageContext(ctx, this.typingIntervalMs)
        : null;
      handler(error as Error, messageContext);
    });
  }

  async launch() {
    await this.bot.launch();
  }

  async sendTextToChat(chatId: string | number, text: string) {
    await this.bot.telegram.sendMessage(chatId, text);
  }

  stop(reason: string) {
    this.bot.stop(reason);
  }
}