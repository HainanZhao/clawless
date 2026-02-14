import http from 'node:http';
import { getErrorMessage } from '../utils/error.js';
import { sendJson, readRequestBody, isCallbackAuthorized } from '../utils/httpHelpers.js';

type LogInfoFn = (message: string, details?: unknown) => void;

type ScheduleApiShape = {
  createSchedule: (input: {
    message: string;
    description?: string;
    cronExpression?: string;
    oneTime?: boolean;
    runAt?: Date;
  }) => any;
  listSchedules: () => any;
  getSchedule: (id: string) => any;
  removeSchedule: (id: string) => boolean;
};

export async function handleSchedulerApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestUrl: URL,
  deps: {
    cronScheduler: ScheduleApiShape;
    callbackAuthToken: string;
    callbackMaxBodyBytes: number;
    logInfo: LogInfoFn;
  },
) {
  const {
    cronScheduler,
    callbackAuthToken,
    callbackMaxBodyBytes,
    logInfo,
  } = deps;

  if (!isCallbackAuthorized(req, callbackAuthToken)) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  if (requestUrl.pathname === '/api/schedule' && req.method === 'POST') {
    try {
      const bodyText = await readRequestBody(req, callbackMaxBodyBytes);
      const body = bodyText ? JSON.parse(bodyText) : {};

      if (!body.message || typeof body.message !== 'string') {
        sendJson(res, 400, { ok: false, error: 'Field `message` is required and must be a string' });
        return;
      }

      if (body.description !== undefined && typeof body.description !== 'string') {
        sendJson(res, 400, { ok: false, error: 'Field `description` must be a string' });
        return;
      }

      if (body.cronExpression !== undefined && typeof body.cronExpression !== 'string') {
        sendJson(res, 400, { ok: false, error: 'Field `cronExpression` must be a string' });
        return;
      }

      let runAt: Date | undefined;
      if (body.runAt) {
        runAt = new Date(body.runAt);
        if (isNaN(runAt.getTime())) {
          sendJson(res, 400, { ok: false, error: 'Invalid date format for `runAt`' });
          return;
        }
      }

      const schedule = cronScheduler.createSchedule({
        message: body.message,
        description: body.description,
        cronExpression: body.cronExpression,
        oneTime: body.oneTime === true,
        runAt,
      });

      logInfo('Schedule created', { scheduleId: schedule.id });
      sendJson(res, 201, { ok: true, schedule });
    } catch (error: any) {
      logInfo('Failed to create schedule', { error: getErrorMessage(error) });
      sendJson(res, 400, { ok: false, error: getErrorMessage(error, 'Failed to create schedule') });
    }
    return;
  }

  if (requestUrl.pathname === '/api/schedule' && req.method === 'GET') {
    try {
      const schedules = cronScheduler.listSchedules();
      sendJson(res, 200, { ok: true, schedules });
    } catch (error: any) {
      sendJson(res, 500, { ok: false, error: getErrorMessage(error, 'Failed to list schedules') });
    }
    return;
  }

  const getScheduleMatch = requestUrl.pathname.match(/^\/api\/schedule\/([^/]+)$/);
  if (getScheduleMatch && req.method === 'GET') {
    try {
      const scheduleId = getScheduleMatch[1];
      const schedule = cronScheduler.getSchedule(scheduleId);
      if (!schedule) {
        sendJson(res, 404, { ok: false, error: 'Schedule not found' });
        return;
      }
      sendJson(res, 200, { ok: true, schedule });
    } catch (error: any) {
      sendJson(res, 500, { ok: false, error: getErrorMessage(error, 'Failed to get schedule') });
    }
    return;
  }

  const deleteScheduleMatch = requestUrl.pathname.match(/^\/api\/schedule\/([^/]+)$/);
  if (deleteScheduleMatch && req.method === 'DELETE') {
    try {
      const scheduleId = deleteScheduleMatch[1];
      const removed = cronScheduler.removeSchedule(scheduleId);
      if (!removed) {
        sendJson(res, 404, { ok: false, error: 'Schedule not found' });
        return;
      }
      logInfo('Schedule removed', { scheduleId });
      sendJson(res, 200, { ok: true, message: 'Schedule removed' });
    } catch (error: any) {
      sendJson(res, 500, { ok: false, error: getErrorMessage(error, 'Failed to remove schedule') });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
}
