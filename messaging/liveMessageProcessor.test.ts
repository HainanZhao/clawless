import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processSingleTelegramMessage } from './liveMessageProcessor.js';

describe('processSingleTelegramMessage', () => {
  const mockMessageContext = {
    chatId: 'test-chat-id',
    text: 'test message',
    startTyping: vi.fn().mockReturnValue(() => {}),
    sendText: vi.fn().mockResolvedValue({}),
    startLiveMessage: vi.fn().mockResolvedValue('live-msg-id'),
    updateLiveMessage: vi.fn().mockResolvedValue({}),
    finalizeLiveMessage: vi.fn().mockResolvedValue({}),
    removeMessage: vi.fn().mockResolvedValue({}),
  };

  const mockParams = {
    messageContext: mockMessageContext,
    messageRequestId: 1,
    maxResponseLength: 100,
    streamUpdateIntervalMs: 100,
    messageGapThresholdMs: 100,
    acpDebugStream: false,
    runAcpPrompt: vi.fn(),
    scheduleAsyncJob: vi.fn().mockResolvedValue('job-id'),
    logInfo: vi.fn(),
    getErrorMessage: vi.fn((e) => (e as Error).message),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the actual task message content in ASYNC mode', async () => {
    const fullResponse = '[MODE: ASYNC] Do some work';
    mockParams.runAcpPrompt.mockResolvedValue(fullResponse);

    await processSingleTelegramMessage(mockParams as any);

    expect(mockParams.scheduleAsyncJob).toHaveBeenCalled();
    expect(mockMessageContext.sendText).toHaveBeenCalledWith(
      expect.stringContaining('[MODE: ASYNC] Do some work (Reference: job_'),
    );
  });
});
