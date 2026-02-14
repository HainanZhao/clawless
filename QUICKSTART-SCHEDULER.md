# Quick Start Guide: Scheduler Feature

This guide will help you start using the scheduler feature in under 5 minutes.

## Prerequisites

1. Clawless is installed and configured
2. You have sent at least one message to your bot (to establish chat binding)
3. The bridge is running (`npm run dev` or `npm start`)

## Basic Usage

### Talk to Gemini Naturally

The easiest way to use the scheduler is to just ask Gemini:

**Examples:**

```
You: "Remind me to take a break in 30 minutes"

You: "Check my calendar every morning at 9am and send me a summary"

You: "Every Friday at 5pm, remind me to review my weekly goals"

You: "What schedules do I have?"

You: "Cancel the daily calendar check"
```

Gemini will handle all the API calls automatically!

## Direct API Usage

### 1. Create a Recurring Schedule

```bash
curl -X POST http://127.0.0.1:8788/api/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What time is it?",
    "description": "Time check",
    "cronExpression": "0 9 * * *"
  }'
```

**Response:**
```json
{
  "ok": true,
  "schedule": {
    "id": "schedule_1707835800000_abc123",
    "message": "What time is it?",
    "description": "Time check",
    "cronExpression": "0 9 * * *",
    "oneTime": false,
    "active": true,
    "createdAt": "2026-02-13T10:00:00.000Z"
  }
}
```

### 2. Create a One-Time Schedule

```bash
# Schedule for 30 seconds from now
if ! RUN_AT=$(date -u -d "+30 seconds" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
  # Fallback for macOS/BSD date
  RUN_AT=$(date -u -v+30S +"%Y-%m-%dT%H:%M:%SZ")
fi

curl -X POST http://127.0.0.1:8788/api/schedule \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"Test reminder\",
    \"oneTime\": true,
    \"runAt\": \"${RUN_AT}\"
  }"
```

### 3. List All Schedules

```bash
curl http://127.0.0.1:8788/api/schedule | jq .
```

### 4. Delete a Schedule

```bash
curl -X DELETE http://127.0.0.1:8788/api/schedule/SCHEDULE_ID
```

## Common Cron Expressions

| Expression | Meaning |
|------------|---------|
| `0 9 * * *` | Every day at 9:00 AM |
| `0 */6 * * *` | Every 6 hours |
| `*/30 * * * *` | Every 30 minutes |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 17 * * 5` | Every Friday at 5:00 PM |
| `0 0 1 * *` | First day of month at midnight |

**Cron format:** `minute hour day month weekday`

## What Happens When a Job Runs?

1. **Scheduler triggers** at the scheduled time
2. **Message is sent** to a new Gemini CLI session
3. **Gemini processes** the message (can use tools, files, etc.)
4. **Response is sent** to your Telegram chat automatically

Example Telegram message you'll receive:
```
🔔 Scheduled task completed:

Daily calendar summary

Today's events:
- 9:00 AM: Team standup
- 2:00 PM: Project review
- 4:30 PM: 1-on-1 with manager
```

## Testing Your First Schedule

1. **Start the bridge:**
   ```bash
   npm run dev
   ```

2. **Create a test schedule (runs in 30 seconds):**
   ```bash
   if ! RUN_AT=$(date -u -d "+30 seconds" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
     # Fallback for macOS/BSD date
     RUN_AT=$(date -u -v+30S +"%Y-%m-%dT%H:%M:%SZ")
   fi
   
   curl -X POST http://127.0.0.1:8788/api/schedule \
     -H "Content-Type: application/json" \
     -d "{
       \"message\": \"Hello! This is a test scheduled message.\",
       \"description\": \"Test\",
       \"oneTime\": true,
       \"runAt\": \"${RUN_AT}\"
     }"
   ```

3. **Wait 30 seconds** - You should receive a message in Telegram!

4. **Or ask Gemini directly:**
   ```
   Send me a test message in 30 seconds
   ```

## With Authentication

If you have `CALLBACK_AUTH_TOKEN` set in your config:

```bash
curl -X POST http://127.0.0.1:8788/api/schedule \
  -H "Content-Type: application/json" \
  -H "x-callback-token: YOUR_TOKEN_HERE" \
  -d '{
    "message": "Test",
    "cronExpression": "0 9 * * *"
  }'
```

## Troubleshooting

### "No target chat available"
**Solution:** Send at least one message to your bot first.

### Schedule not executing
**Solution:** 
- Check bridge logs for errors
- Verify cron expression is valid
- Ensure bridge is still running

### Can't reach API
**Solution:**
- Verify bridge is running: `curl http://127.0.0.1:8788/healthz`
- Check if port 8788 is available
- Look for errors in bridge logs

## Next Steps

- Read [SCHEDULER.md](SCHEDULER.md) for complete API documentation
- Read [TESTING.md](TESTING.md) for comprehensive testing guide
- Run `./scripts/test-scheduler.sh` for automated tests
- View `./scripts/gemini-scheduler-examples.sh` for more examples

## Pro Tips

1. **Descriptions matter**: Add clear descriptions to help you remember what each schedule does
2. **Test with one-time first**: Before setting up recurring jobs, test with a one-time schedule
3. **Use natural language**: Just ask Gemini - it's easier than curl commands!
4. **Check regularly**: Use "What schedules do I have?" to review active schedules
5. **Timezone aware**: Set `TZ` environment variable if needed (default is UTC)

## Example Workflows

### Daily Morning Routine
```
You: "Every morning at 7am, check my calendar and the weather, then send me a summary"
```

### Work Break Reminders
```
You: "Remind me to take a break every 2 hours during work days"
```

### Weekly Review
```
You: "Every Sunday at 6pm, remind me to plan my goals for next week"
```

### Custom Notifications
```
You: "Check if there are any urgent emails every 30 minutes and notify me if found"
```

---

That's it! You're ready to start scheduling with Clawless. 🎉
