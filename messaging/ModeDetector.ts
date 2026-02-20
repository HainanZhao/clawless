export enum ConversationMode {
  QUICK = 'QUICK',
  ASYNC = 'ASYNC',
  UNKNOWN = 'UNKNOWN',
}

export type ModeDetectionResult = {
  mode: ConversationMode;
  isDetected: boolean;
  content: string;
};

const QUICK_PREFIX = '[MODE: QUICK]';
const ASYNC_PREFIX = '[MODE: ASYNC]';

/**
 * Detects the conversation mode from a text chunk or full response.
 * If detected, returns the mode and the content with the prefix stripped.
 */
export function detectConversationMode(text: string): ModeDetectionResult {
  const trimmed = text.trim();

  if (trimmed.startsWith(QUICK_PREFIX)) {
    return {
      mode: ConversationMode.QUICK,
      isDetected: true,
      content: text.replace(QUICK_PREFIX, '').trimStart(),
    };
  }

  if (trimmed.startsWith(ASYNC_PREFIX)) {
    return {
      mode: ConversationMode.ASYNC,
      isDetected: true,
      content: text.replace(ASYNC_PREFIX, '').trimStart(),
    };
  }

  return {
    mode: ConversationMode.UNKNOWN,
    isDetected: false,
    content: text,
  };
}

/**
 * Wraps a user request in the standard HYBRID MODE instructions.
 */
export function wrapHybridPrompt(userRequest: string): string {
  return `[SYSTEM: HYBRID MODE]
Instructions:
1. Analyze the User Request below.
2. Determine if it is "Quick" (answer immediately) or "Async" (background task).
3. Use ASYNC mode if:
   - The request requires using any tools (e.g., reading files, running commands, searching code)
   - The task might take longer than 10 seconds
   - Examples: scanning a repo codebase, running tests, building projects, fetching URLs, processing multiple files
   - IMPORTANT: If you choose ASYNC mode, DO NOT perform the task now. DO NOT call any tools. Just provide the confirmation message and exit.
4. Use QUICK mode only for:
   - Simple questions that can be answered from knowledge
   - No tools required
   - Response can be generated in a few seconds

Response Format:
- "[MODE: QUICK] " followed by your immediate answer
- "[MODE: ASYNC] " followed by a specific task description of what will be done (this text becomes the background agent's instruction — include relevant context such as file paths, flags, or scope from the user request so the background agent has everything it needs)

User Request: "${userRequest}"`;
}
