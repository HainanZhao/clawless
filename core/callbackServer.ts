import http from 'node:http';
import { handleSchedulerApiRequest } from '../scheduler/schedulerApiHandler.js';
import { sendJson, isCallbackAuthorized, readRequestBody } from '../utils/httpHelpers.js';
import { getErrorMessage } from '../utils/error.js';
import { normalizeOutgoingText } from '../utils/commandText.js';
import { resolveChatId } from '../utils/callbackState.js';

type LogInfoFn = (message: string, details?: unknown) => void;

type CreateCallbackServerParams = {
  callbackHost: string;
  callbackPort: number;
  callbackAuthToken: string;
  callbackMaxBodyBytes: number;
  cronScheduler: any;
  messagingClient: any;
  getLastIncomingChatId: () => string | null;
  logInfo: LogInfoFn;
};

export function createCallbackServer({
  callbackHost,
  callbackPort,
  callbackAuthToken,
  callbackMaxBodyBytes,
  cronScheduler,
  messagingClient,
  getLastIncomingChatId,
  logInfo,
}: CreateCallbackServerParams) {
  let callbackServer: http.Server | null = null;

  const handleCallbackRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const hostHeader = req.headers.host || `${callbackHost}:${callbackPort}`;
    const requestUrl = new URL(req.url || '/', `http://${hostHeader}`);

    if (requestUrl.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
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

    if (requestUrl.pathname !== '/callback/telegram') {
      sendJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' });
      return;
    }

    if (!isCallbackAuthorized(req, callbackAuthToken)) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    let body: any = null;
    try {
      const bodyText = await readRequestBody(req, callbackMaxBodyBytes);
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch (error: any) {
      sendJson(res, 400, { ok: false, error: getErrorMessage(error, 'Invalid JSON body') });
      return;
    }

    const callbackText = normalizeOutgoingText(body?.text);
    if (!callbackText) {
      sendJson(res, 400, { ok: false, error: 'Field `text` is required' });
      return;
    }

    const targetChatId = resolveChatId(
      body?.chatId
      ?? requestUrl.searchParams.get('chatId')
      ?? getLastIncomingChatId(),
    );

    if (!targetChatId) {
      sendJson(res, 400, {
        ok: false,
        error: 'No chat id available. Send one Telegram message to the bot once to bind a target chat, or provide `chatId` in this callback request.',
      });
      return;
    }

    try {
      await messagingClient.sendTextToChat(targetChatId, callbackText);
      logInfo('Callback message sent', { targetChatId });
      sendJson(res, 200, { ok: true, chatId: targetChatId });
    } catch (error: any) {
      sendJson(res, 500, { ok: false, error: getErrorMessage(error, 'Failed to send Telegram message') });
    }
  };

  const startCallbackServer = () => {
    if (callbackServer) {
      return;
    }

    callbackServer = http.createServer((req, res) => {
      handleCallbackRequest(req, res).catch((error: any) => {
        sendJson(res, 500, { ok: false, error: getErrorMessage(error, 'Internal callback server error') });
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
        endpoint: '/callback/telegram',
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
