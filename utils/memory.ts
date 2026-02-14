import fs from 'node:fs';
import path from 'node:path';
import { getErrorMessage } from './error.js';

type LogInfoFn = (message: string, details?: unknown) => void;

export function ensureMemoryFile(memoryFilePath: string, logInfo: LogInfoFn) {
  fs.mkdirSync(path.dirname(memoryFilePath), { recursive: true });

  if (!fs.existsSync(memoryFilePath)) {
    const template = [
      '# Clawless Memory',
      '',
      'This file stores durable memory notes for Clawless.',
      '',
      '## Notes',
      '',
    ].join('\n');

    fs.writeFileSync(memoryFilePath, `${template}\n`, 'utf8');
    logInfo('Created memory file', { memoryFilePath });
  }
}

export function readMemoryContext(memoryFilePath: string, memoryMaxChars: number, logInfo: LogInfoFn) {
  try {
    const content = fs.readFileSync(memoryFilePath, 'utf8');
    if (content.length <= memoryMaxChars) {
      return content;
    }

    return content.slice(-memoryMaxChars);
  } catch (error: any) {
    logInfo('Unable to read memory file; continuing without memory context', {
      memoryFilePath,
      error: getErrorMessage(error),
    });
    return '';
  }
}

export function buildPromptWithMemory(params: {
  userPrompt: string;
  memoryFilePath: string;
  callbackHost: string;
  callbackPort: number;
  callbackChatStateFilePath: string;
  callbackAuthToken: string;
  memoryContext: string;
}) {
  const {
    userPrompt,
    memoryFilePath,
    callbackHost,
    callbackPort,
    callbackChatStateFilePath,
    callbackAuthToken,
    memoryContext,
  } = params;

  const callbackEndpoint = `http://${callbackHost}:${callbackPort}/callback/telegram`;
  const scheduleEndpoint = `http://${callbackHost}:${callbackPort}/api/schedule`;

  return [
    'System instruction:',
    `- Persistent memory file path: ${memoryFilePath}`,
    '- If user asks to remember/memorize/save for later, append a concise bullet under "## Notes" in that file.',
    '- Do not overwrite existing memory entries; append only.',
    `- Callback endpoint for proactive notifications (cron/jobs): POST ${callbackEndpoint}`,
    '- Callback payload should include a JSON `text` field; `chatId` is optional.',
    `- Persisted callback chat binding file: ${callbackChatStateFilePath}`,
    '- If no `chatId` is provided, the bridge sends to the persisted bound chat.',
    '- For scheduled jobs, include callback delivery steps so results are pushed to Telegram when jobs complete.',
    '',
    '**Scheduler API:**',
    `- Create schedule: POST ${scheduleEndpoint}`,
    '  Body format for recurring: {"message": "prompt text", "description": "optional", "cronExpression": "* * * * *"}',
    '  Body format for one-time: {"message": "prompt text", "description": "optional", "oneTime": true, "runAt": "2026-12-31T23:59:59Z"}',
    '  Cron format: "minute hour day month weekday" (e.g., "0 9 * * *" = daily at 9am, "*/5 * * * *" = every 5 minutes)',
    `- List schedules: GET ${scheduleEndpoint}`,
    `- Get schedule: GET ${scheduleEndpoint}/:id`,
    `- Delete schedule: DELETE ${scheduleEndpoint}/:id`,
    '- When schedule runs, it executes the message through Gemini CLI and sends results to Telegram.',
    '- Use this API when user asks to schedule tasks, set reminders, or create recurring jobs.',
    callbackAuthToken
      ? '- Scheduler auth is enabled: include `x-callback-token` (or bearer token) header when creating requests.'
      : '- Scheduler auth is disabled unless CALLBACK_AUTH_TOKEN is configured.',
    '',
    'Current memory context:',
    memoryContext,
    '',
    'User message:',
    userPrompt,
  ].join('\n');
}
