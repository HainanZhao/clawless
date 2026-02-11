import { streamText } from 'ai';
import { ACP } from '@ai-sdk/acp';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Validate required environment variables
if (!process.env.TELEGRAM_TOKEN) {
  console.error('Error: TELEGRAM_TOKEN environment variable is required');
  process.exit(1);
}

// Initialize Telegram bot
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

// Initialize the Gemini CLI as an ACP Agent
const geminiAgent = new ACP({
  command: 'gemini', 
  args: ['--protocol', 'acp'] // Tells the CLI to speak ACP
});

// Configure message update interval (in ms) to avoid Telegram rate limits
const UPDATE_INTERVAL_MS = parseInt(process.env.UPDATE_INTERVAL_MS || '1500', 10);

// Maximum response length to prevent memory issues (Telegram has 4096 char limit anyway)
const MAX_RESPONSE_LENGTH = parseInt(process.env.MAX_RESPONSE_LENGTH || '4000', 10);

// Track last update time per message to implement buffering
const lastUpdateTime = new Map();

/**
 * Handles incoming text messages from Telegram
 */
bot.on('text', async (ctx) => {
  let fullResponse = "";
  const messageId = `${ctx.chat.id}_${Date.now()}`;
  
  try {
    // Send initial "thinking" message
    const info = await ctx.reply("🤔 Thinking...");
    lastUpdateTime.set(messageId, Date.now());

    // Stream tokens from the CLI via ACP
    const { textStream } = await streamText({
      model: geminiAgent,
      prompt: ctx.message.text,
    });

    for await (const delta of textStream) {
      fullResponse += delta;
      
      // Enforce maximum response length to prevent memory issues
      if (fullResponse.length > MAX_RESPONSE_LENGTH) {
        fullResponse = fullResponse.substring(0, MAX_RESPONSE_LENGTH) + '\n\n[Response truncated due to length]';
        break;
      }
      
      const now = Date.now();
      const timeSinceLastUpdate = now - (lastUpdateTime.get(messageId) || 0);
      
      // Update Telegram message at intervals to simulate streaming
      // while respecting rate limits
      if (timeSinceLastUpdate >= UPDATE_INTERVAL_MS) {
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id, 
            info.message_id, 
            null, 
            fullResponse || "..."
          );
          lastUpdateTime.set(messageId, now);
        } catch (editError) {
          // Check for specific Telegram error codes
          // 400 with "message is not modified" is expected and can be ignored
          const isNotModified = editError.response?.error_code === 400 && 
                               editError.description?.includes('message is not modified');
          
          if (!isNotModified) {
            console.error('Error updating message:', editError.message);
          }
        }
      }
    }
    
    // Final update with complete response
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id, 
        info.message_id, 
        null, 
        fullResponse || "No response received."
      );
    } catch (finalError) {
      // If final edit fails, send as new message
      if (fullResponse) {
        await ctx.reply(fullResponse);
      }
    }
    
    // Cleanup
    lastUpdateTime.delete(messageId);
    
  } catch (error) {
    console.error('Error processing message:', error);
    await ctx.reply(`❌ Error: ${error.message}`);
    lastUpdateTime.delete(messageId);
  }
});

// Error handling
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
  ctx.reply('⚠️ An error occurred while processing your request.').catch(() => {});
});

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('Received SIGINT, stopping bot...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('Received SIGTERM, stopping bot...');
  bot.stop('SIGTERM');
});

// Launch the bot
console.log('Starting Telegram-Gemini ACP Bridge...');
bot.launch()
  .then(() => {
    console.log('Bot launched successfully!');
    console.log(`Update interval: ${UPDATE_INTERVAL_MS}ms`);
  })
  .catch((error) => {
    console.error('Failed to launch bot:', error);
    process.exit(1);
  });
