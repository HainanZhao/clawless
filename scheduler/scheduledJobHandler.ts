import type { ScheduleConfig } from './cronScheduler.js';
import { getErrorMessage } from '../utils/error.js';

export interface ScheduledJobHandlerDeps {
  logInfo: (message: string, details?: unknown) => void;
  buildPromptWithMemory: (userPrompt: string) => Promise<string>;
  runScheduledPromptWithTempAcp: (promptForAgent: string, scheduleId: string) => Promise<string>;
  resolveTargetChatId: () => string | null;
  sendTextToChat: (chatId: string | number, text: string) => Promise<void>;
  normalizeOutgoingText: (text: unknown) => string;
}

export function createScheduledJobHandler(deps: ScheduledJobHandlerDeps) {
  const {
    logInfo,
    buildPromptWithMemory,
    runScheduledPromptWithTempAcp,
    resolveTargetChatId,
    sendTextToChat,
    normalizeOutgoingText,
  } = deps;

  return async function handleScheduledJob(schedule: ScheduleConfig): Promise<void> {
    logInfo('Executing scheduled job', { scheduleId: schedule.id, message: schedule.message });

    try {
      const promptForAgent = await buildPromptWithMemory(schedule.message);
      logInfo('Scheduler prompt payload sent to agent', {
        scheduleId: schedule.id,
        prompt: promptForAgent,
      });

      const response = await runScheduledPromptWithTempAcp(promptForAgent, schedule.id);

      const targetChatId = resolveTargetChatId();
      if (targetChatId) {
        await sendTextToChat(targetChatId, normalizeOutgoingText(response));
        logInfo('Scheduled job result sent to Telegram', { scheduleId: schedule.id, chatId: targetChatId });
      } else {
        logInfo('No target chat available for scheduled job result', { scheduleId: schedule.id });
      }
    } catch (error: any) {
      logInfo('Scheduled job execution failed', {
        scheduleId: schedule.id,
        error: getErrorMessage(error),
      });

      const targetChatId = resolveTargetChatId();
      if (targetChatId) {
        const errorMessage = `❌ Scheduled task failed: ${schedule.description || schedule.message}\n\nError: ${getErrorMessage(error)}`;
        await sendTextToChat(targetChatId, normalizeOutgoingText(errorMessage));
      }
    }
  };
}
