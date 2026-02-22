import { isUserAuthorized } from '../utils/telegramWhitelist.js';
import { isAbortCommand } from '../utils/commandText.js';
import { getErrorMessage } from '../utils/error.js';

type RegisterTelegramHandlersParams = {
  messagingClient: any;
  telegramWhitelist: string[];
  enforceWhitelist?: boolean;
  platformLabel?: string;
  hasActiveAcpPrompt: () => boolean;
  cancelActiveAcpPrompt: () => Promise<void>;
  enqueueMessage: (messageContext: any) => Promise<void>;
  onAbortRequested: () => void;
  onChatBound: (chatId: string) => void;
};

export function registerTelegramHandlers({
  messagingClient,
  telegramWhitelist,
  enforceWhitelist = true,
  platformLabel = 'Messaging',
  hasActiveAcpPrompt,
  cancelActiveAcpPrompt,
  enqueueMessage,
  onAbortRequested,
  onChatBound,
}: RegisterTelegramHandlersParams) {
  const handleIncomingTelegramMessage = async (messageContext: any) => {
    const principals = [messageContext.username, messageContext.userId]
      .filter((value): value is string | number => value !== undefined && value !== null)
      .map(String)
      .filter((s) => s.length > 0);

    const isAuthorized = principals.some((principal) => isUserAuthorized(principal, telegramWhitelist));

    if (enforceWhitelist && !isAuthorized) {
      console.warn(
        `Unauthorized access attempt from username: ${messageContext.username ?? 'none'} (ID: ${messageContext.userId ?? 'unknown'})`,
      );
      await messageContext.sendText('🚫 Unauthorized. This bot is restricted to authorized users only.');
      return;
    }

    if (messageContext.chatId !== undefined && messageContext.chatId !== null) {
      onChatBound(String(messageContext.chatId));
    }

    if (isAbortCommand(messageContext.text)) {
      if (!hasActiveAcpPrompt()) {
        await messageContext.sendText('ℹ️ No active agent action to abort.');
        return;
      }

      onAbortRequested();
      await messageContext.sendText('⏹️ Abort requested. Stopping current agent action...');
      await cancelActiveAcpPrompt();
      return;
    }

    enqueueMessage(messageContext).catch(async (error: unknown) => {
      console.error('Error processing message:', error);
      const errorMessage = getErrorMessage(error);
      if (errorMessage.toLowerCase().includes('aborted by user')) {
        await messageContext.sendText('⏹️ Agent action stopped.');
        return;
      }
      await messageContext.sendText(`❌ Error: ${errorMessage}`);
    });
  };

  const handleTelegramClientError = (error: Error, messageContext: any) => {
    console.error(`${platformLabel} client error:`, error);
    if (messageContext) {
      messageContext.sendText('⚠️ An error occurred while processing your request.').catch(() => {});
    }
  };

  messagingClient.onTextMessage(handleIncomingTelegramMessage);
  messagingClient.onError(handleTelegramClientError);
}
