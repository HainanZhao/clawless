type LogInfoFn = (message: string, details?: unknown) => void;

type CreateMessageQueueProcessorParams = {
  processSingleMessage: (messageContext: any, requestId: number) => Promise<void>;
  logInfo: LogInfoFn;
  getErrorMessage: (error: unknown, fallbackMessage?: string) => string;
};

export function createMessageQueueProcessor({
  processSingleMessage,
  logInfo,
  getErrorMessage,
}: CreateMessageQueueProcessorParams) {
  const messageQueue: Array<any> = [];
  let isQueueProcessing = false;
  let messageSequence = 0;

  const processQueue = async () => {
    if (isQueueProcessing) {
      return;
    }

    isQueueProcessing = true;
    while (messageQueue.length > 0) {
      const item = messageQueue.shift();
      if (!item) {
        continue;
      }

      try {
        logInfo('Processing queued message', { requestId: item.requestId, queueLength: messageQueue.length });
        await processSingleMessage(item.messageContext, item.requestId);
        logInfo('Message processed', { requestId: item.requestId });
        item.resolve();
      } catch (error: any) {
        logInfo('Message processing failed', { requestId: item.requestId, error: getErrorMessage(error) });
        item.reject(error);
      }
    }

    isQueueProcessing = false;
  };

  const enqueueMessage = (messageContext: any) => {
    return new Promise<void>((resolve, reject) => {
      const requestId = ++messageSequence;
      messageQueue.push({ requestId, messageContext, resolve, reject });
      logInfo('Message enqueued', { requestId, queueLength: messageQueue.length });
      processQueue().catch((error) => {
        console.error('Queue processor failed:', error);
      });
    });
  };

  return {
    enqueueMessage,
    getQueueLength: () => messageQueue.length,
  };
}
