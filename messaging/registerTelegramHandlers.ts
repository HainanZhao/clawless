import { isUserAuthorized } from '../utils/telegramWhitelist.js';
import { isAbortCommand } from '../utils/commandText.js';
import { getErrorMessage } from '../utils/error.js';

type RegisterTelegramHandlersParams = {
  messagingClient: any;
  telegramWhitelist: string[];
  hasActiveAcpPrompt: () => boolean;
  cancelActiveAcpPrompt: () => Promise<void>;
  enqueueMessage: (messageContext: any) => Promise<void>;
  onAbortRequested: () => void;
  onChatBound: (chatId: string) => void;
};

export function registerTelegramHandlers({
  messagingClient,
  telegramWhitelist,
  hasActiveAcpPrompt,
  cancelActiveAcpPrompt,
  enqueueMessage,
  onAbortRequested,
  onChatBound,
}: RegisterTelegramHandlersParams) {
  messagingClient.onTextMessage(async (messageContext: any) => {
    if (!isUserAuthorized(messageContext.username, telegramWhitelist)) {
      console.warn(`Unauthorized access attempt from username: ${messageContext.username ?? 'none'} (ID: ${messageContext.userId ?? 'unknown'})`);
      await messageContext.sendText('🚫 Unauthorized. This bot is restricted to authorized users only.');
      return;
    }

    if (messageContext.chatId !== undefined && messageContext.chatId !== null) {
      onChatBound(String(messageContext.chatId));
    }

    if (isAbortCommand(messageContext.text)) {
      if (!hasActiveAcpPrompt()) {
        await messageContext.sendText('ℹ️ No active Gemini action to abort.');
        return;
      }

      onAbortRequested();
      await messageContext.sendText('⏹️ Abort requested. Stopping current Gemini action...');
      await cancelActiveAcpPrompt();
      return;
    }

    enqueueMessage(messageContext)
      .catch(async (error: unknown) => {
        console.error('Error processing message:', error);
        const errorMessage = getErrorMessage(error);
        if (errorMessage.toLowerCase().includes('aborted by user')) {
          await messageContext.sendText('⏹️ Gemini action stopped.');
          return;
        }
        await messageContext.sendText(`❌ Error: ${errorMessage}`);
      });
  });

  messagingClient.onError((error: Error, messageContext: any) => {
    console.error('Telegram client error:', error);
    if (messageContext) {
      messageContext.sendText('⚠️ An error occurred while processing your request.').catch(() => {});
    }
  });
}
