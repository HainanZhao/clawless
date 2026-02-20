import type { ScheduleConfig } from './cronScheduler.js';
import { getErrorMessage } from '../utils/error.js';

export interface ScheduledJobHandlerDeps {
  logInfo: (message: string, details?: unknown) => void;
  buildPromptWithMemory: (userPrompt: string) => Promise<string>;
  runScheduledPromptWithTempAcp: (promptForAgent: string, scheduleId: string) => Promise<string>;
  resolveTargetChatId: () => string | null;
  sendTextToChat: (chatId: string | number, text: string) => Promise<void>;
  normalizeOutgoingText: (text: unknown) => string;
  onConversationComplete?: (userMessage: string, botResponse: string, chatId: string) => void;
  appendContextToAgent?: (text: string) => Promise<void>;
}

function formatBackgroundTaskPrompt(userRequest: string): string {
  return `[SYSTEM: BACKGROUND TASK]
Perform the following task immediately. 
Do not ask any follow-up questions. 
Provide the final result directly.

User Request: "${userRequest}"`;
}

function formatBackgroundTaskResult(request: string, result: string): string {
  return `📢 Background task completed.\n\nOriginal Request: "${request}"\n\nResult:\n${result}`;
}

export function createScheduledJobHandler(deps: ScheduledJobHandlerDeps) {
  const {
    logInfo,
    buildPromptWithMemory,
    runScheduledPromptWithTempAcp,
    resolveTargetChatId,
    sendTextToChat,
    normalizeOutgoingText,
    onConversationComplete,
    appendContextToAgent,
  } = deps;

  return async function handleScheduledJob(schedule: ScheduleConfig): Promise<void> {
    logInfo('handleScheduledJob called', { scheduleId: schedule.id, message: schedule.message, type: schedule.type });

    try {
      const jobPrompt = formatBackgroundTaskPrompt(schedule.message);
      const promptForAgent = await buildPromptWithMemory(jobPrompt);

      logInfo('Scheduler prompt payload sent to agent', {
        scheduleId: schedule.id,
        prompt: promptForAgent,
      });

      const response = await runScheduledPromptWithTempAcp(promptForAgent, schedule.id);

      if (schedule.type === 'async_conversation') {
        const chatId = schedule.metadata?.chatId;
        if (!chatId) {
          logInfo('Missing chatId for async conversation job', { scheduleId: schedule.id });
          return;
        }

        const formattedResponse = formatBackgroundTaskResult(schedule.message, response);
        await sendTextToChat(chatId, normalizeOutgoingText(formattedResponse));
        logInfo('Async conversation result sent directly to chat', { scheduleId: schedule.id, chatId });

        if (onConversationComplete) {
          onConversationComplete(schedule.message, response, chatId);
        }

        if (appendContextToAgent) {
          const contextUpdate = formatBackgroundTaskResult(schedule.message, response);
          void appendContextToAgent(contextUpdate);
        }
      } else {
        // Standard cron job behavior
        const targetChatId = resolveTargetChatId();
        if (targetChatId) {
          await sendTextToChat(targetChatId, normalizeOutgoingText(response));
          logInfo('Scheduled job result sent to Telegram', { scheduleId: schedule.id, chatId: targetChatId });
        } else {
          logInfo('No target chat available for scheduled job result', { scheduleId: schedule.id });
        }
      }
    } catch (error: any) {
      logInfo('Scheduled job execution failed', {
        scheduleId: schedule.id,
        error: getErrorMessage(error),
      });

      const chatId = schedule.type === 'async_conversation' ? schedule.metadata?.chatId : resolveTargetChatId();

      if (chatId) {
        const errorDetail = getErrorMessage(error);
        const errorMessage = `❌ ${schedule.type === 'async_conversation' ? 'Background task' : 'Scheduled task'} failed: ${schedule.description || schedule.message}\n\nError: ${errorDetail}`;
        await sendTextToChat(chatId, normalizeOutgoingText(errorMessage));
      }
    }
  };
}
