import { describe, it, expect } from 'vitest';
import { toTelegramMarkdown, escapeMarkdownV2 } from './telegramClient.js';

describe('telegramClient', () => {
  describe('escapeMarkdownV2', () => {
    it('should escape all reserved characters', () => {
      const text = '\\ _ * [ ] ( ) ~ ` > # + - = | { } . !';
      const escaped = escapeMarkdownV2(text);
      expect(escaped).toBe('\\\\ \\_ \\* \\[ \\] \\( \\) \\~ \\` \\> \\# \\+ \\- \\= \\| \\{ \\} \\. \\!');
    });

    it('should escape parentheses specifically', () => {
      const text = 'Hello (world)';
      expect(escapeMarkdownV2(text)).toBe('Hello \\(world\\)');
    });

    it('should escape backslashes correctly when followed by reserved characters', () => {
      // This is the common failing case where an existing backslash + paren becomes \\(
      // (one escaped backslash followed by an unescaped paren)
      const text = 'A \\(backslashed paren)';
      // Fixed version should be A \\\(backslashed paren\)
      // This means: one literal backslash (\), then one literal paren (\()
      expect(escapeMarkdownV2(text)).toBe('A \\\\\\(backslashed paren\\)');
    });
  });

  describe('toTelegramMarkdown', () => {
    it('should convert standard markdown and escape parentheses', () => {
      const text = 'This is a **bold** message (with parens)';
      const converted = toTelegramMarkdown(text);
      // In MarkdownV2, bold is *bold*
      // telegramify-markdown converts ** to *
      expect(converted).toContain('*bold*');
      expect(converted).toContain('\\(with parens\\)');
    });

    it('should handle broken markdown by escaping', () => {
      // Unclosed bold
      const text = '**bold';
      const converted = toTelegramMarkdown(text);
      // It should either be escaped or properly converted
      // telegramify-markdown v1.3.2 seems to escape it
      expect(converted).toContain('\\*\\*bold');
    });

    it('should escape standalone reserved characters', () => {
      const text = 'A ) without opening';
      const converted = toTelegramMarkdown(text.trim());
      expect(converted.trim()).toBe('A \\) without opening');
    });
  });
});
