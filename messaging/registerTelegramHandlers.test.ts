import { describe, it, expect, vi } from 'vitest';
import { registerTelegramHandlers } from './registerTelegramHandlers.js';

describe('registerTelegramHandlers', () => {
  it('should register named handlers instead of anonymous ones', () => {
    const messagingClient = {
      onTextMessage: vi.fn(),
      onError: vi.fn(),
    };
    
    registerTelegramHandlers({
      messagingClient: messagingClient as any,
      telegramWhitelist: [],
      hasActiveAcpPrompt: () => false,
      cancelActiveAcpPrompt: async () => {},
      enqueueMessage: async () => {},
      onAbortRequested: () => {},
      onChatBound: () => {},
    });

    expect(messagingClient.onTextMessage).toHaveBeenCalledWith(expect.any(Function));
    const messageHandler = messagingClient.onTextMessage.mock.calls[0][0];
    // Arrow functions assigned to constants should have names in ES6+
    expect(messageHandler.name).toBe('handleIncomingTelegramMessage');

    expect(messagingClient.onError).toHaveBeenCalledWith(expect.any(Function));
    const errorHandler = messagingClient.onError.mock.calls[0][0];
    expect(errorHandler.name).toBe('handleTelegramClientError');
  });
});
