import { describe, it, expect, vi } from 'vitest';
import { SemanticConversationMemory } from './semanticConversationMemory.js';

describe('SemanticConversationMemory', () => {
  it('should log an error when failing to initialize the database', async () => {
    const logInfo = vi.fn();
    const logError = vi.fn();
    // Using a path that is likely to fail due to permissions or being a directory
    const config = {
      enabled: true,
      storePath: '/proc/invalid_path/db.sqlite',
      maxEntries: 10,
      maxCharsPerEntry: 100,
    };

    const memory = new SemanticConversationMemory(config, logInfo, logError);
    
    const entry = {
      timestamp: new Date().toISOString(),
      chatId: '123',
      userMessage: 'hello',
      botResponse: 'world',
      platform: 'telegram',
    };

    // This should trigger logError inside indexEntry -> getDatabase
    await memory.indexEntry(entry);

    expect(logError).toHaveBeenCalled();
    const errorCall = logError.mock.calls.find(call => 
      call[0].includes('Failed to index') || call[0].includes('failed to initialize semantic memory database')
    );
    expect(errorCall).toBeDefined();
  });

  it('should log an error when recall fails', async () => {
    const logInfo = vi.fn();
    const logError = vi.fn();
    const config = {
      enabled: true,
      storePath: '/proc/invalid_path/db.sqlite',
      maxEntries: 10,
      maxCharsPerEntry: 100,
    };

    const memory = new SemanticConversationMemory(config, logInfo, logError);
    
    await memory.getRelevantEntries('123', 'test', 5);

    expect(logError).toHaveBeenCalled();
    const errorCall = logError.mock.calls.find(call => 
      call[0].includes('Failed semantic conversation recall') || call[0].includes('failed to initialize semantic memory database')
    );
    expect(errorCall).toBeDefined();
  });
});
