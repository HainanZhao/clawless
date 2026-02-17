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
    const trimmed = content.trim();
    if (!trimmed) {
      return '';
    }

    if (trimmed.length <= memoryMaxChars) {
      return trimmed;
    }

    return trimmed.slice(-memoryMaxChars);
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
  messagingPlatform: string;
}) {
  const {
    userPrompt,
    memoryFilePath,
    callbackHost,
    callbackPort,
    callbackChatStateFilePath,
    callbackAuthToken,
    memoryContext,
    messagingPlatform,
  } = params;

  const callbackEndpoint = `http://${callbackHost}:${callbackPort}/callback/${messagingPlatform}`;
  const scheduleEndpoint = `http://${callbackHost}:${callbackPort}/api/schedule`;
  const semanticRecallEndpoint = `http://${callbackHost}:${callbackPort}/api/memory/semantic-recall`;

  const parts = [
    'System instruction:',
    `- Persistent memory file path: ${memoryFilePath}`,
    '- If user asks to remember/memorize/save for later, append a concise bullet under "## Notes" in that file.',
    '- Do not overwrite existing memory entries; append only.',
    `- Callback endpoint for proactive notifications (cron/jobs): POST ${callbackEndpoint}`,
    '- Callback payload should include a JSON `text` field; `chatId` is optional.',
    `- Persisted callback chat binding file: ${callbackChatStateFilePath}`,
    '- If no `chatId` is provided, the bridge sends to the persisted bound chat.',
    `- For scheduled jobs, include callback delivery steps so results are pushed to ${messagingPlatform} when jobs complete.`,
    '',
    '**Scheduler API:**',
    `- Create schedule: POST ${scheduleEndpoint}`,
    `- Update schedule: PATCH ${scheduleEndpoint}/:id`,
    '  Body format for recurring: {"message": "prompt text", "description": "optional", "cronExpression": "* * * * *"}',
    '  Body format for one-time: {"message": "prompt text", "description": "optional", "oneTime": true, "runAt": "2026-12-31T23:59:59Z"}',
    '  Body format for update: {"message": "optional", "description": "optional", "cronExpression": "optional", "oneTime": true|false, "runAt": "optional ISO date", "active": true|false}',
    '  Cron format: "minute hour day month weekday" (e.g., "0 9 * * *" = daily at 9am, "*/5 * * * *" = every 5 minutes)',
    `- List schedules: GET ${scheduleEndpoint}`,
    `- Get schedule: GET ${scheduleEndpoint}/:id`,
    `- Delete schedule: DELETE ${scheduleEndpoint}/:id`,
    '- Never edit scheduler persistence files directly; always mutate schedules through the Scheduler API.',
    `- When schedule runs, it executes the message through Gemini CLI and sends results to ${messagingPlatform}.`,
    '- Use this API when user asks to schedule tasks, set reminders, or create recurring jobs.',
    '',
    '**Semantic recall API (on-demand):**',
    `- Endpoint: POST ${semanticRecallEndpoint}`,
    '- Request body: {"input": "current user question", "chatId": "optional", "topK": 3}',
    '- Use this endpoint only when you need additional historical context that is not obvious from current prompt/memory.',
    '- Prefer dynamic fetch over assuming prior context; keep prompts lean unless context is required.',
    '- If `chatId` is omitted, server falls back to persisted bound chat context when available.',
    callbackAuthToken
      ? '- API auth is enabled (scheduler + semantic recall): include `x-callback-token` (or bearer token) header.'
      : '- API auth is disabled unless CALLBACK_AUTH_TOKEN is configured.',
  ];

  if (memoryContext && memoryContext.trim().length > 0) {
    parts.push('', 'Current memory context:', memoryContext);
  }

  parts.push('', 'User message:', userPrompt);

  return parts.join('\n');
}
