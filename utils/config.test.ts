import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { getConfig, expandHomePath, resetConfig } from './config';

vi.mock('node:os');

describe('config utils', () => {
  const mockHome = '/home/user';

  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    resetConfig();
    // Clear process.env for each test or set defaults
    vi.stubEnv('TELEGRAM_TOKEN', '123:abc');
    vi.stubEnv('MESSAGING_PLATFORM', 'telegram');
    vi.stubEnv('CLAWLESS_HOME', '');
    vi.stubEnv('CLI_AGENT', 'gemini');
    vi.stubEnv('MEMORY_FILE_PATH', '');
    vi.stubEnv('SCHEDULES_FILE_PATH', '');
    vi.stubEnv('CONVERSATION_HISTORY_FILE_PATH', '');
    vi.stubEnv('CONVERSATION_SEMANTIC_STORE_PATH', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('expandHomePath', () => {
    it('expands ~ to home directory', () => {
      expect(expandHomePath('~')).toBe(mockHome);
    });

    it('expands ~/path to absolute path', () => {
      expect(expandHomePath('~/my/path')).toBe(path.join(mockHome, 'my/path'));
    });

    it('returns original value for absolute paths', () => {
      expect(expandHomePath('/other/path')).toBe('/other/path');
    });

    it('returns empty string if value is empty', () => {
      expect(expandHomePath('')).toBe(mockHome);
    });
  });

  describe('getConfig', () => {
    it('returns default values when environment is empty (except required ones)', () => {
      const config = getConfig();
      expect(config.MESSAGING_PLATFORM).toBe('telegram');
      expect(config.CLI_AGENT).toBe('gemini');
      expect(config.CLAWLESS_HOME).toBe(path.join(mockHome, '.clawless'));
    });

    it('overrides defaults from process.env', () => {
      vi.stubEnv('CLI_AGENT', 'claude');
      const config = getConfig();
      expect(config.CLI_AGENT).toBe('claude');
    });

    it('resolves derived paths based on CLAWLESS_HOME', () => {
      vi.stubEnv('CLAWLESS_HOME', '~/my-clawless');
      const config = getConfig();
      expect(config.CLAWLESS_HOME).toBe(path.join(mockHome, 'my-clawless'));
      expect(config.MEMORY_FILE_PATH).toBe(path.join(mockHome, 'my-clawless', 'MEMORY.md'));
    });

    it('validates Telegram platform requires token', () => {
      vi.stubEnv('MESSAGING_PLATFORM', 'telegram');
      vi.stubEnv('TELEGRAM_TOKEN', '');

      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => getConfig()).toThrow('process.exit called');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('TELEGRAM_TOKEN environment variable is required'),
      );
    });

    it('validates Slack platform requires tokens', () => {
      vi.stubEnv('MESSAGING_PLATFORM', 'slack');
      vi.stubEnv('SLACK_BOT_TOKEN', '');

      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => getConfig()).toThrow('process.exit called');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('SLACK_BOT_TOKEN environment variable is required'),
      );
    });
  });
});
