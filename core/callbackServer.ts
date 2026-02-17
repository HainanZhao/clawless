import http from 'node:http';
import { handleSchedulerApiRequest } from '../scheduler/schedulerApiHandler.js';
import { sendJson, isCallbackAuthorized, readRequestBody } from '../utils/httpHelpers.js';
import { getErrorMessage } from '../utils/error.js';
import { normalizeOutgoingText } from '../utils/commandText.js';
import { resolveChatId } from '../utils/callbackState.js';
import { formatConversationHistoryForPrompt } from '../utils/conversationHistory.js';

type LogInfoFn = (message: string, details?: unknown) => void;

type CreateCallbackServerParams = {
  callbackHost: string;
  callbackPort: number;
  callbackAuthToken: string;
  callbackMaxBodyBytes: number;
  messagingPlatform: string;
  cronScheduler: any;
  messagingClient: any;
  getLastIncomingChatId: () => string | null;
  semanticConversationMemory: any;
  conversationHistoryMaxTotalChars: number;
  conversationHistoryRecapTopK: number;
  logInfo: LogInfoFn;
};

export function createCallbackServer({
  callbackHost,
  callbackPort,
  callbackAuthToken,
  callbackMaxBodyBytes,
  messagingPlatform,
  cronScheduler,
  messagingClient,
  getLastIncomingChatId,
  semanticConversationMemory,
  conversationHistoryMaxTotalChars,
  conversationHistoryRecapTopK,
  logInfo,
}: CreateCallbackServerParams) {
  let callbackServer: http.Server | null = null;
  const platformCallbackPath = `/callback/${messagingPlatform}`;

  const sendLoggedJson = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    statusCode: number,
    payload: Record<string, unknown>,
  ) => {
    const requestPath = req.url || '/';
    logInfo('Callback/API response', {
      method: req.method || 'UNKNOWN',
      path: requestPath,
      statusCode,
    });
    sendJson(res, statusCode, payload);
  };

  const handleCallbackRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const hostHeader = req.headers.host || `${callbackHost}:${callbackPort}`;
    const requestUrl = new URL(req.url || '/', `http://${hostHeader}`);

    if (requestUrl.pathname.startsWith('/api/') || requestUrl.pathname.startsWith('/callback')) {
      logInfo('Callback/API request', {
        method: req.method || 'UNKNOWN',
        path: requestUrl.pathname,
        hasAuthHeader: Boolean(req.headers.authorization || req.headers['x-callback-token']),
      });
    }

    if (requestUrl.pathname === '/healthz') {
      sendLoggedJson(req, res, 200, { ok: true });
      return;
    }

    if (requestUrl.pathname.startsWith('/api/schedule')) {
      await handleSchedulerApiRequest(req, res, requestUrl, {
        cronScheduler,
        callbackAuthToken,
        callbackMaxBodyBytes,
        logInfo,
      });
      return;
    }

    if (requestUrl.pathname === '/api/memory/semantic-recall') {
      if (req.method !== 'POST') {
        sendLoggedJson(req, res, 405, { ok: false, error: 'Method not allowed' });
        return;
      }

      if (!isCallbackAuthorized(req, callbackAuthToken)) {
        sendLoggedJson(req, res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }

      if (!semanticConversationMemory?.isEnabled) {
        sendLoggedJson(req, res, 503, { ok: false, error: 'Semantic recall is disabled' });
        return;
      }

      let body: any = null;
      try {
        const bodyText = await readRequestBody(req, callbackMaxBodyBytes);
        body = bodyText ? JSON.parse(bodyText) : {};
      } catch (error: any) {
        sendLoggedJson(req, res, 400, { ok: false, error: getErrorMessage(error, 'Invalid JSON body') });
        return;
      }

      const input = typeof body?.input === 'string' ? body.input.trim() : '';
      const chatId = resolveChatId(body?.chatId ?? requestUrl.searchParams.get('chatId') ?? getLastIncomingChatId());
      const topKRaw = Number(body?.topK ?? requestUrl.searchParams.get('topK') ?? conversationHistoryRecapTopK);
      const topK =
        Number.isFinite(topKRaw) && topKRaw > 0 ? Math.max(1, Math.floor(topKRaw)) : conversationHistoryRecapTopK;

      if (!input) {
        sendLoggedJson(req, res, 400, { ok: false, error: 'Field `input` is required' });
        return;
      }

      if (!chatId) {
        sendLoggedJson(req, res, 400, {
          ok: false,
          error: `No chat id available. Provide \`chatId\` or send one ${messagingPlatform} message to bind chat context.`,
        });
        return;
      }

      try {
        const entries = await semanticConversationMemory.getRelevantEntries(chatId, input, topK);
        const recap = formatConversationHistoryForPrompt(entries, conversationHistoryMaxTotalChars);

        sendLoggedJson(req, res, 200, {
          ok: true,
          chatId,
          topK,
          count: entries.length,
          recap,
          entries,
        });
      } catch (error: any) {
        sendLoggedJson(req, res, 500, { ok: false, error: getErrorMessage(error, 'Semantic recall query failed') });
      }

      return;
    }

    const isCallbackEndpoint =
      requestUrl.pathname === '/callback' ||
      requestUrl.pathname === '/callback/telegram' ||
      requestUrl.pathname === platformCallbackPath;

    if (!isCallbackEndpoint) {
      sendLoggedJson(req, res, 404, { ok: false, error: 'Not found' });
      return;
    }

    if (req.method !== 'POST') {
      sendLoggedJson(req, res, 405, { ok: false, error: 'Method not allowed' });
      return;
    }

    if (!isCallbackAuthorized(req, callbackAuthToken)) {
      sendLoggedJson(req, res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    let body: any = null;
    try {
      const bodyText = await readRequestBody(req, callbackMaxBodyBytes);
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch (error: any) {
      sendLoggedJson(req, res, 400, { ok: false, error: getErrorMessage(error, 'Invalid JSON body') });
      return;
    }

    const callbackText = normalizeOutgoingText(body?.text);
    if (!callbackText) {
      sendLoggedJson(req, res, 400, { ok: false, error: 'Field `text` is required' });
      return;
    }

    const targetChatId = resolveChatId(
      body?.chatId ?? requestUrl.searchParams.get('chatId') ?? getLastIncomingChatId(),
    );

    if (!targetChatId) {
      sendLoggedJson(req, res, 400, {
        ok: false,
        error: `No chat id available. Send one ${messagingPlatform} message to the bot once to bind a target chat, or provide \`chatId\` in this callback request.`,
      });
      return;
    }

    try {
      await messagingClient.sendTextToChat(targetChatId, callbackText);
      logInfo('Callback message sent', { targetChatId, messagingPlatform });
      sendLoggedJson(req, res, 200, { ok: true, chatId: targetChatId });
    } catch (error: any) {
      sendLoggedJson(req, res, 500, {
        ok: false,
        error: getErrorMessage(error, `Failed to send ${messagingPlatform} message`),
      });
    }
  };

  const startCallbackServer = () => {
    if (callbackServer) {
      return;
    }

    callbackServer = http.createServer((req, res) => {
      handleCallbackRequest(req, res).catch((error: any) => {
        sendLoggedJson(req, res, 500, { ok: false, error: getErrorMessage(error, 'Internal callback server error') });
      });
    });

    callbackServer.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        logInfo('Callback server port already in use; skipping local callback listener for this process', {
          host: callbackHost,
          port: callbackPort,
        });
        callbackServer?.close();
        callbackServer = null;
        return;
      }

      console.error('Callback server error:', error);
    });

    callbackServer.listen(callbackPort, callbackHost, () => {
      logInfo('Callback server listening', {
        host: callbackHost,
        port: callbackPort,
        authEnabled: Boolean(callbackAuthToken),
        endpoints: [
          '/callback',
          '/callback/telegram',
          platformCallbackPath,
          '/api/schedule',
          '/api/memory/semantic-recall',
        ],
      });
    });
  };

  const stopCallbackServer = () => {
    if (!callbackServer) {
      return;
    }

    callbackServer.close();
    callbackServer = null;
  };

  return {
    startCallbackServer,
    stopCallbackServer,
  };
}
