import fs from 'node:fs';
import path from 'node:path';
import blessed from 'blessed';
import { SUPPORTED_AGENTS } from '../core/agents/agentFactory.js';

type ConfigValue = string | number | boolean | string[];

type ConfigField = {
  key: string;
  label: string;
  description: string;
  valueType: 'string' | 'number' | 'boolean' | 'stringArray' | 'enum';
  enumValues?: readonly string[];
  isSecret?: boolean;
  isRequired: (config: Record<string, unknown>) => boolean;
  isVisible: (config: Record<string, unknown>) => boolean;
  order: number;
};

const CONFIG_FIELDS: ConfigField[] = [
  {
    key: 'messagingPlatform',
    label: 'messagingPlatform',
    description: 'Active platform adapter. Controls which platform-specific keys are shown.',
    valueType: 'enum',
    enumValues: ['telegram', 'slack'],
    isRequired: () => true,
    isVisible: () => true,
    order: 1,
  },
  {
    key: 'telegramToken',
    label: 'telegramToken',
    description: 'Telegram bot token from BotFather.',
    valueType: 'string',
    isSecret: true,
    isRequired: (config) => String(config.messagingPlatform || 'telegram') === 'telegram',
    isVisible: (config) => String(config.messagingPlatform || 'telegram') === 'telegram',
    order: 2,
  },
  {
    key: 'telegramWhitelist',
    label: 'telegramWhitelist',
    description: 'Comma-separated Telegram usernames (without @).',
    valueType: 'stringArray',
    isRequired: (config) => String(config.messagingPlatform || 'telegram') === 'telegram',
    isVisible: (config) => String(config.messagingPlatform || 'telegram') === 'telegram',
    order: 3,
  },
  {
    key: 'slackBotToken',
    label: 'slackBotToken',
    description: 'Slack bot token (xoxb-...).',
    valueType: 'string',
    isSecret: true,
    isRequired: (config) => String(config.messagingPlatform || 'telegram') === 'slack',
    isVisible: (config) => String(config.messagingPlatform || 'telegram') === 'slack',
    order: 4,
  },
  {
    key: 'slackSigningSecret',
    label: 'slackSigningSecret',
    description: 'Slack signing secret.',
    valueType: 'string',
    isSecret: true,
    isRequired: (config) => String(config.messagingPlatform || 'telegram') === 'slack',
    isVisible: (config) => String(config.messagingPlatform || 'telegram') === 'slack',
    order: 5,
  },
  {
    key: 'slackWhitelist',
    label: 'slackWhitelist',
    description: 'Comma-separated Slack user IDs or emails.',
    valueType: 'stringArray',
    isRequired: (config) => String(config.messagingPlatform || 'telegram') === 'slack',
    isVisible: (config) => String(config.messagingPlatform || 'telegram') === 'slack',
    order: 6,
  },
  {
    key: 'slackAppToken',
    label: 'slackAppToken',
    description: 'Slack Socket Mode app token (xapp-...).',
    valueType: 'string',
    isSecret: true,
    isRequired: (config) => String(config.messagingPlatform || 'telegram') === 'slack',
    isVisible: (config) => String(config.messagingPlatform || 'telegram') === 'slack',
    order: 7,
  },
  {
    key: 'timezone',
    label: 'timezone',
    description: 'Scheduler timezone (IANA TZ name).',
    valueType: 'string',
    isRequired: () => false,
    isVisible: () => true,
    order: 20,
  },
  {
    key: 'typingIntervalMs',
    label: 'typingIntervalMs',
    description: 'Typing indicator refresh interval in ms.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 21,
  },
  {
    key: 'streamUpdateIntervalMs',
    label: 'streamUpdateIntervalMs',
    description: 'Minimum interval between stream update edits in ms.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 22,
  },
  {
    key: 'cliAgent',
    label: 'cliAgent',
    description: 'CLI agent backend to run.',
    valueType: 'enum',
    enumValues: SUPPORTED_AGENTS,
    isRequired: () => true,
    isVisible: () => true,
    order: 0,
  },
  {
    key: 'cliAgentApprovalMode',
    label: 'cliAgentApprovalMode',
    description: 'CLI agent approval behavior for tool/edit actions.',
    valueType: 'enum',
    enumValues: ['default', 'auto_edit', 'yolo', 'plan'],
    isRequired: () => false,
    isVisible: () => true,
    order: 25,
  },
  {
    key: 'cliAgentModel',
    label: 'cliAgentModel',
    description: 'Optional CLI agent model override.',
    valueType: 'string',
    isRequired: () => false,
    isVisible: () => true,
    order: 26,
  },
  {
    key: 'acpPermissionStrategy',
    label: 'acpPermissionStrategy',
    description: 'How ACP permission prompts are auto-selected.',
    valueType: 'enum',
    enumValues: ['allow_once', 'reject_once', 'cancelled'],
    isRequired: () => false,
    isVisible: () => true,
    order: 26,
  },
  {
    key: 'cliAgentTimeoutMs',
    label: 'cliAgentTimeoutMs',
    description: 'Hard timeout for one CLI agent run in ms.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 27,
  },
  {
    key: 'cliAgentNoOutputTimeoutMs',
    label: 'cliAgentNoOutputTimeoutMs',
    description: 'Idle timeout when CLI agent emits no output in ms.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 28,
  },
  {
    key: 'cliAgentKillGraceMs',
    label: 'cliAgentKillGraceMs',
    description: 'Grace period after terminate before force kill in ms.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 29,
  },
  {
    key: 'acpPrewarmRetryMs',
    label: 'acpPrewarmRetryMs',
    description: 'Retry delay for ACP prewarm failures in ms.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 30,
  },
  {
    key: 'acpPrewarmMaxRetries',
    label: 'acpPrewarmMaxRetries',
    description: 'Maximum ACP prewarm retries; 0 means unlimited.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 31,
  },
  {
    key: 'acpMcpServersJson',
    label: 'acpMcpServersJson',
    description: 'Optional JSON override for ACP MCP server list.',
    valueType: 'string',
    isRequired: () => false,
    isVisible: () => true,
    order: 32,
  },
  {
    key: 'maxResponseLength',
    label: 'maxResponseLength',
    description: 'Maximum response length in characters.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 33,
  },
  {
    key: 'acpStreamStdout',
    label: 'acpStreamStdout',
    description: 'Emit raw ACP stream chunks to stdout.',
    valueType: 'boolean',
    isRequired: () => false,
    isVisible: () => true,
    order: 34,
  },
  {
    key: 'acpDebugStream',
    label: 'acpDebugStream',
    description: 'Emit structured ACP stream debug logs.',
    valueType: 'boolean',
    isRequired: () => false,
    isVisible: () => true,
    order: 35,
  },
  {
    key: 'heartbeatIntervalMs',
    label: 'heartbeatIntervalMs',
    description: 'Heartbeat log interval in ms (0 disables).',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 36,
  },
  {
    key: 'callbackHost',
    label: 'callbackHost',
    description: 'Bind host for callback/API server.',
    valueType: 'string',
    isRequired: () => false,
    isVisible: () => true,
    order: 37,
  },
  {
    key: 'callbackPort',
    label: 'callbackPort',
    description: 'Bind port for callback/API server.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 38,
  },
  {
    key: 'callbackAuthToken',
    label: 'callbackAuthToken',
    description: 'Optional token for callback/API authentication.',
    valueType: 'string',
    isSecret: true,
    isRequired: () => false,
    isVisible: () => true,
    order: 39,
  },
  {
    key: 'callbackMaxBodyBytes',
    label: 'callbackMaxBodyBytes',
    description: 'Maximum callback/API request body size in bytes.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 40,
  },
  {
    key: 'clawlessHome',
    label: 'clawlessHome',
    description: 'Base directory for runtime state files.',
    valueType: 'string',
    isRequired: () => false,
    isVisible: () => true,
    order: 41,
  },
  {
    key: 'memoryFilePath',
    label: 'memoryFilePath',
    description: 'Persistent memory file injected into prompt context.',
    valueType: 'string',
    isRequired: () => false,
    isVisible: () => true,
    order: 42,
  },
  {
    key: 'memoryMaxChars',
    label: 'memoryMaxChars',
    description: 'Maximum memory-file characters injected into context.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 43,
  },
  {
    key: 'conversationHistoryEnabled',
    label: 'conversationHistoryEnabled',
    description: 'Enable or disable conversation history tracking.',
    valueType: 'boolean',
    isRequired: () => false,
    isVisible: () => true,
    order: 44,
  },
  {
    key: 'conversationHistoryFilePath',
    label: 'conversationHistoryFilePath',
    description: 'Conversation history JSONL storage file path.',
    valueType: 'string',
    isRequired: () => false,
    isVisible: () => true,
    order: 45,
  },
  {
    key: 'conversationHistoryMaxEntries',
    label: 'conversationHistoryMaxEntries',
    description: 'Maximum retained conversation entries.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 46,
  },
  {
    key: 'conversationHistoryMaxCharsPerEntry',
    label: 'conversationHistoryMaxCharsPerEntry',
    description: 'Maximum characters stored per history entry.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 47,
  },
  {
    key: 'conversationHistoryMaxTotalChars',
    label: 'conversationHistoryMaxTotalChars',
    description: 'Maximum total history chars used in recap context.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 48,
  },
  {
    key: 'conversationHistoryRecapTopK',
    label: 'conversationHistoryRecapTopK',
    description: 'Default number of entries returned in recap.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 49,
  },
  {
    key: 'conversationSemanticRecallEnabled',
    label: 'conversationSemanticRecallEnabled',
    description: 'Enable or disable semantic recall features.',
    valueType: 'boolean',
    isRequired: () => false,
    isVisible: () => true,
    order: 50,
  },
  {
    key: 'conversationSemanticStorePath',
    label: 'conversationSemanticStorePath',
    description: 'Semantic memory SQLite store file path.',
    valueType: 'string',
    isRequired: () => false,
    isVisible: () => true,
    order: 52,
  },
  {
    key: 'conversationSemanticMaxEntries',
    label: 'conversationSemanticMaxEntries',
    description: 'Maximum retained semantic memory entries.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 53,
  },
  {
    key: 'conversationSemanticMaxCharsPerEntry',
    label: 'conversationSemanticMaxCharsPerEntry',
    description: 'Maximum chars per semantic entry for lexical recall.',
    valueType: 'number',
    isRequired: () => false,
    isVisible: () => true,
    order: 54,
  },
  {
    key: 'schedulesFilePath',
    label: 'schedulesFilePath',
    description: 'Scheduler persistence file path.',
    valueType: 'string',
    isRequired: () => false,
    isVisible: () => true,
    order: 56,
  },
];

function maskSecret(text: string): string {
  if (!text) {
    return '';
  }

  if (text.length <= 4) {
    return '*'.repeat(text.length);
  }

  return `${text.slice(0, 2)}${'*'.repeat(Math.max(4, text.length - 4))}${text.slice(-2)}`;
}

function formatFieldValue(value: unknown, field: ConfigField): string {
  if (field.valueType === 'stringArray') {
    return Array.isArray(value) ? value.join(', ') : '';
  }
  if (field.valueType === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (value === null || value === undefined) {
    return '';
  }
  const text = String(value);
  if (field.isSecret) {
    return maskSecret(text);
  }
  return text;
}

function rawFieldValue(value: unknown, field: ConfigField): string {
  if (field.valueType === 'stringArray') {
    return Array.isArray(value) ? value.join(', ') : '';
  }
  if (field.valueType === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function parseFieldValue(input: string, field: ConfigField): ConfigValue {
  if (field.valueType === 'number') {
    const parsed = Number.parseInt(input.trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (field.valueType === 'boolean') {
    return input.trim().toLowerCase() === 'true';
  }
  if (field.valueType === 'stringArray') {
    return input
      .split(',')
      .map((item) => item.trim().replace(/^@/, ''))
      .filter(Boolean);
  }
  return input;
}

function validateRequiredFields(config: Record<string, unknown>) {
  const missing: string[] = [];

  for (const field of CONFIG_FIELDS) {
    if (!field.isVisible(config) || !field.isRequired(config)) {
      continue;
    }

    const value = config[field.key];
    if (field.valueType === 'stringArray') {
      if (!Array.isArray(value) || value.length === 0) {
        missing.push(field.label);
      }
      continue;
    }

    const text = String(value ?? '').trim();
    if (!text) {
      missing.push(field.label);
    }
  }

  if (String(config.messagingPlatform || 'telegram') === 'telegram') {
    const token = String(config.telegramToken || '').trim();
    if (!token.includes(':') && !missing.includes('telegramToken')) {
      missing.push('telegramToken');
    }
  }

  return missing;
}

function getVisibleFields(config: Record<string, unknown>): ConfigField[] {
  return CONFIG_FIELDS.filter((field) => field.isVisible(config)).sort((left, right) => {
    const leftRequired = left.isRequired(config) ? 0 : 1;
    const rightRequired = right.isRequired(config) ? 0 : 1;
    if (leftRequired !== rightRequired) {
      return leftRequired - rightRequired;
    }
    if (leftRequired === 1) {
      return left.key.localeCompare(right.key);
    }
    return left.order - right.order;
  });
}

function truncateText(text: string, width: number): string {
  if (text.length <= width) {
    return text;
  }
  if (width <= 1) {
    return text.slice(0, 1);
  }
  return `${text.slice(0, width - 1)}…`;
}

function cycleEnum(field: ConfigField, current: string, direction: 1 | -1): string {
  const values = field.enumValues || [];
  if (values.length === 0) {
    return current;
  }
  const index = Math.max(0, values.indexOf(current));
  const nextIndex = (index + direction + values.length) % values.length;
  return values[nextIndex];
}

export type TuiResult = {
  saved: boolean;
};

export async function runConfigTui(
  configPath: string,
  defaultConfigTemplate: Record<string, unknown>,
  resolveConfigPath: (configPath: string) => string,
): Promise<TuiResult> {
  const absolutePath = resolveConfigPath(configPath);
  let existingConfig: Record<string, unknown> = {};
  if (fs.existsSync(absolutePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existingConfig = parsed as Record<string, unknown>;
      }
    } catch (error: any) {
      throw new Error(`Failed to parse config JSON at ${absolutePath}: ${error.message}`);
    }
  }

  const baseConfig = {
    ...defaultConfigTemplate,
    ...existingConfig,
  } as Record<string, unknown>;

  const screen = blessed.screen({
    smartCSR: true,
    title: 'Clawless Config TUI',
  });

  blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    style: { fg: 'black', bg: 'cyan' },
    content: ' ↑/↓ move  Tab next  Shift+Tab prev  Enter edit  ←/→ enum  s save  q quit  Esc cancel ',
  });

  const pathBar = blessed.box({
    parent: screen,
    top: 1,
    left: 0,
    width: '100%',
    height: 1,
    style: { fg: 'white', bg: 'blue' },
    content: ` Target: ${absolutePath}`,
  });

  const keysList = blessed.list({
    parent: screen,
    top: 2,
    left: 0,
    width: '100%',
    height: '100%-4',
    border: 'line',
    label: ' Keys ',
    tags: true,
    keys: false,
    vi: false,
    mouse: true,
    style: {
      selected: { bg: 'blue', fg: 'white', bold: true },
      item: { fg: 'white' },
      border: { fg: 'gray' },
    },
    scrollbar: {
      ch: ' ',
    },
  });

  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    style: { fg: 'white', bg: 'magenta' },
    content: ' Ready ',
  });

  const prompt = blessed.prompt({
    parent: screen,
    border: 'line',
    height: 9,
    width: '70%',
    top: 'center',
    left: 'center',
    label: ' Edit Value ',
    tags: true,
    keys: true,
    vi: true,
    hidden: true,
    style: {
      fg: 'white',
      bg: 'black',
      border: { fg: 'cyan' },
    },
  });

  const quitPrompt = blessed.prompt({
    parent: screen,
    border: 'line',
    height: 9,
    width: '70%',
    top: 'center',
    left: 'center',
    label: ' Quit Confirmation ',
    tags: true,
    keys: true,
    vi: true,
    hidden: true,
    style: {
      fg: 'white',
      bg: 'black',
      border: { fg: 'yellow' },
    },
  });

  let visibleFields = getVisibleFields(baseConfig);
  let selectedIndex = 0;
  let saved = false;
  let dirty = false;
  let finished = false;

  const setStatus = (text: string, kind: 'info' | 'success' | 'warning' | 'error' = 'info') => {
    const styleByKind = {
      info: { fg: 'white', bg: 'magenta' },
      success: { fg: 'black', bg: 'green' },
      warning: { fg: 'black', bg: 'yellow' },
      error: { fg: 'white', bg: 'red' },
    } as const;
    statusBar.style = styleByKind[kind];
    statusBar.setContent(` ${text}`);
  };

  const getSelectedField = () => visibleFields[selectedIndex];

  const renderList = () => {
    visibleFields = getVisibleFields(baseConfig);
    if (selectedIndex >= visibleFields.length) {
      selectedIndex = Math.max(0, visibleFields.length - 1);
    }

    if (visibleFields.length === 0) {
      keysList.setItems([' No keys available']);
      keysList.select(0);
      return;
    }

    const width = Math.max(20, keysList.width as number);
    const lineWidth = width - 8;
    const missingSet = new Set(validateRequiredFields(baseConfig));

    const items = visibleFields.map((field, index) => {
      const marker = index === selectedIndex ? '›' : ' ';
      const required = field.isRequired(baseConfig) ? '*' : ' ';
      const missing = missingSet.has(field.label) ? '!' : ' ';
      const value = formatFieldValue(baseConfig[field.key], field);
      const preview = value ? ` = ${value.replace(/\s+/g, ' ')}` : '';
      const left = `${marker} ${missing}${required} ${field.label}${preview}`;
      const tip = field.description.replace(/\s+/g, ' ');
      const tipWidth = Math.max(16, Math.floor(lineWidth * 0.38));
      const leftWidth = Math.max(12, lineWidth - tipWidth - 1);
      const leftPart = truncateText(left, leftWidth);
      const tipPart = truncateText(tip, tipWidth);
      const gapWidth = Math.max(1, lineWidth - leftPart.length - tipPart.length);
      const gap = ' '.repeat(gapWidth);

      if (lineWidth < 30) {
        return truncateText(left, lineWidth);
      }

      return `${leftPart}${gap}{gray-fg}${tipPart}{/gray-fg}`;
    });

    keysList.setItems(items);
    keysList.select(selectedIndex);
  };

  const renderAll = () => {
    const missingCount = validateRequiredFields(baseConfig).length;
    const dirtySuffix = dirty ? '  [Unsaved changes]' : '';
    const validationSuffix = missingCount > 0 ? `  [${missingCount} required missing]` : '  [Ready to save]';
    pathBar.setContent(` Target: ${absolutePath}${dirtySuffix}${validationSuffix}`);
    renderList();
    screen.render();
  };

  const saveConfig = () => {
    const missing = validateRequiredFields(baseConfig);
    if (missing.length > 0) {
      setStatus(`Cannot save. Missing required: ${missing.join(', ')}`, 'error');
      renderAll();
      return;
    }

    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, `${JSON.stringify(baseConfig, null, 2)}\n`, 'utf8');
    saved = true;
    dirty = false;
    setStatus(`Saved config: ${absolutePath}`, 'success');
    screen.render();
    setTimeout(() => {
      if (!finished) {
        finished = true;
        screen.destroy();
      }
    }, 120);
  };

  const editField = (field: ConfigField) => {
    if (field.valueType === 'enum') {
      const current = String(baseConfig[field.key] || '');
      const next = cycleEnum(field, current, 1);
      if (next !== current) {
        baseConfig[field.key] = next;
        dirty = true;
      }
      setStatus(`Set ${field.label} = ${next}`, 'info');
      renderAll();
      return;
    }

    if (field.valueType === 'boolean') {
      const previous = Boolean(baseConfig[field.key]);
      const next = !previous;
      baseConfig[field.key] = next;
      if (next !== previous) {
        dirty = true;
      }
      setStatus(`Set ${field.label} = ${String(next)}`, 'info');
      renderAll();
      return;
    }

    const currentValue = rawFieldValue(baseConfig[field.key], field);

    prompt.input(`Edit ${field.label}`, currentValue, (_error, value) => {
      if (typeof value === 'string') {
        const parsed = parseFieldValue(value, field);
        const nextSerialized = JSON.stringify(parsed);
        const previousSerialized = JSON.stringify(baseConfig[field.key]);
        baseConfig[field.key] = parsed;
        if (nextSerialized !== previousSerialized) {
          dirty = true;
        }
        setStatus(`Updated ${field.label}`, 'info');
      } else {
        setStatus(`Canceled edit for ${field.label}`, 'warning');
      }
      keysList.focus();
      renderAll();
    });
  };

  const moveSelection = (delta: number) => {
    if (visibleFields.length === 0) {
      return;
    }
    selectedIndex = Math.max(0, Math.min(visibleFields.length - 1, selectedIndex + delta));
    renderAll();
  };

  const cycleSelectedEnum = (direction: 1 | -1) => {
    const field = getSelectedField();
    if (!field || field.valueType !== 'enum') {
      return;
    }
    const current = String(baseConfig[field.key] || '');
    const next = cycleEnum(field, current, direction);
    if (next !== current) {
      baseConfig[field.key] = next;
      dirty = true;
    }
    setStatus(`Set ${field.label} = ${next}`, 'info');
    renderAll();
  };

  const closeScreen = () => {
    if (!finished) {
      finished = true;
      screen.destroy();
    }
  };

  const confirmQuit = () => {
    if (!dirty || saved) {
      closeScreen();
      return;
    }

    quitPrompt.input('Unsaved changes. [s] Save  [q] Quit without saving  [c] Cancel (Esc)', '', (_error, value) => {
      const choice = String(value || '')
        .trim()
        .toLowerCase();

      if (choice === 's' || choice === 'save' || choice === 'y' || choice === 'yes') {
        saveConfig();
        return;
      }

      if (choice === 'q' || choice === 'quit' || choice === 'n' || choice === 'no') {
        closeScreen();
        return;
      }

      setStatus('Quit canceled', 'warning');
      keysList.focus();
      renderAll();
    });
  };

  keysList.on('select', (_item, index) => {
    selectedIndex = index;
    renderAll();
  });

  screen.key(['up'], () => moveSelection(-1));
  screen.key(['down'], () => moveSelection(1));
  screen.key(['tab'], () => moveSelection(1));
  screen.key(['S-tab'], () => moveSelection(-1));
  screen.key(['left'], () => cycleSelectedEnum(-1));
  screen.key(['right'], () => cycleSelectedEnum(1));

  screen.key(['enter'], () => {
    const field = getSelectedField();
    if (!field) {
      return;
    }
    editField(field);
  });

  screen.key(['s'], () => {
    if (screen.focused === keysList) {
      saveConfig();
    }
  });
  screen.key(['q'], () => {
    if (screen.focused === keysList) {
      confirmQuit();
    }
  });
  screen.key(['C-c'], () => confirmQuit());

  keysList.focus();
  renderAll();

  return await new Promise<TuiResult>((resolve) => {
    screen.on('destroy', () => {
      resolve({ saved });
    });
  });
}
