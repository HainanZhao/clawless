# Scheduler API Manual Testing Guide

This guide walks through manual testing of the scheduler API functionality.

## Prerequisites

1. The bridge must be running with valid platform credentials (Telegram or Slack)
2. You must have sent at least one message/event to the bot/app to establish a chat binding
3. `curl` and `jq` must be installed for the test commands

## Test Setup

1. Start the bridge in development mode:
```bash
npm run dev
```

2. In another terminal, verify the server is running:
```bash
curl http://127.0.0.1:8788/healthz
# Expected: {"ok":true}
```

## Test Cases

### Test 1: Create a Recurring Schedule

Create a schedule that runs every minute:

```bash
curl -X POST http://127.0.0.1:8788/api/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What is the current time?",
    "description": "Test recurring - every minute",
    "cronExpression": "* * * * *"
  }' | jq .
```

**Expected Result:**
- HTTP 201 response
- JSON with `ok: true` and schedule details including an `id`

**Save the schedule ID** from the response for later tests.

### Test 2: List All Schedules

```bash
curl http://127.0.0.1:8788/api/schedule | jq .
```

**Expected Result:**
- HTTP 200 response
- JSON array containing the schedule from Test 1

### Test 3: Get a Specific Schedule

Replace `SCHEDULE_ID` with the ID from Test 1:

```bash
curl http://127.0.0.1:8788/api/schedule/SCHEDULE_ID | jq .
```

**Expected Result:**
- HTTP 200 response
- JSON with the schedule details

### Test 4: Wait for Schedule Execution

Wait for 60-65 seconds and observe:

1. Check the bridge logs for:
   ```
  [timestamp] Executing scheduled job { scheduleId: '...', message: '...' }
   ```

2. Check your active Telegram/Slack destination for a message like:
   ```
   🔔 Scheduled task completed:

   Test recurring - every minute

   [Gemini's response about the current time]
   ```

### Test 5: Create a One-Time Schedule

Create a schedule that runs in 30 seconds:

```bash
# Generate a timestamp 30 seconds from now
RUN_AT=$(date -u -d "+30 seconds" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v+30S +"%Y-%m-%dT%H:%M:%SZ")

curl -X POST http://127.0.0.1:8788/api/schedule \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"This is a one-time test message\",
    \"description\": \"Test one-time schedule\",
    \"oneTime\": true,
    \"runAt\": \"${RUN_AT}\"
  }" | jq .
```

**Expected Result:**
- HTTP 201 response
- Schedule created with `oneTime: true` and `runAt` timestamp

Wait 30+ seconds and verify:
1. The message appears in your active Telegram/Slack destination
2. The schedule is automatically removed (verify with List API)

### Test 6: Test Invalid Cron Expression

```bash
curl -X POST http://127.0.0.1:8788/api/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Test",
    "cronExpression": "invalid cron"
  }' | jq .
```

**Expected Result:**
- HTTP 400 response
- Error message about invalid cron expression

### Test 7: Test Missing Required Fields

```bash
curl -X POST http://127.0.0.1:8788/api/schedule \
  -H "Content-Type: application/json" \
  -d '{}' | jq .
```

**Expected Result:**
- HTTP 400 response
- Error message about missing `message` field

### Test 8: Delete a Schedule

Replace `SCHEDULE_ID` with the ID from Test 1:

```bash
curl -X DELETE http://127.0.0.1:8788/api/schedule/SCHEDULE_ID | jq .
```

**Expected Result:**
- HTTP 200 response
- JSON with `ok: true` and message "Schedule removed"

Verify deletion by listing schedules - the deleted schedule should not appear.

### Test 9: Test with Gemini CLI Integration

Send a message to your active Telegram or Slack bot/app:

```
Create a schedule to check the weather every day at 8am
```

**Expected Behavior:**
1. Gemini should parse your request
2. Call the scheduler API to create a recurring schedule
3. Respond with confirmation of the schedule creation

Then ask:
```
What schedules do I have?
```

**Expected Behavior:**
1. Gemini should query the scheduler API
2. List all active schedules
3. Show details in a human-readable format

Finally:
```
Cancel the weather check schedule
```

**Expected Behavior:**
1. Gemini should identify the schedule to delete
2. Call the DELETE endpoint
3. Confirm the schedule was removed

## Test with Authentication (Optional)

If `CALLBACK_AUTH_TOKEN` is set in your configuration:

```bash
# This should fail with 401 Unauthorized
curl -X POST http://127.0.0.1:8788/api/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Test",
    "cronExpression": "0 9 * * *"
  }' | jq .

# This should succeed
curl -X POST http://127.0.0.1:8788/api/schedule \
  -H "Content-Type: application/json" \
  -H "x-callback-token: YOUR_TOKEN_HERE" \
  -d '{
    "message": "Test",
    "cronExpression": "0 9 * * *"
  }' | jq .
```

## Semantic Recall API Manual Test

### Test 10: Query semantic recall

Use the local semantic recall endpoint to fetch historical context on demand:

```bash
curl -X POST http://127.0.0.1:8788/api/memory/semantic-recall \
  -H "Content-Type: application/json" \
  -d '{
    "input": "What did we decide about semantic memory design?",
    "topK": 3
  }' | jq .
```

**Expected Result:**
- HTTP 200 response
- JSON with `ok: true`
- A `recap` string and `entries` array

If auth is enabled (`CALLBACK_AUTH_TOKEN`):

```bash
curl -X POST http://127.0.0.1:8788/api/memory/semantic-recall \
  -H "Content-Type: application/json" \
  -H "x-callback-token: YOUR_TOKEN_HERE" \
  -d '{
    "input": "What did we decide about semantic memory design?",
    "topK": 3
  }' | jq .
```

### Test 11: Validation errors

Missing `input` should return `400`:

```bash
curl -X POST http://127.0.0.1:8788/api/memory/semantic-recall \
  -H "Content-Type: application/json" \
  -d '{}' | jq .
```

When no chat is bound and no `chatId` is provided, request should return `400` with guidance to bind chat context.

## Cleanup

After testing, remove all test schedules:

```bash
# List all schedules
curl http://127.0.0.1:8788/api/schedule | jq -r '.schedules[].id' | while read id; do
  echo "Deleting schedule: $id"
  curl -X DELETE http://127.0.0.1:8788/api/schedule/$id
done
```

## Common Issues

### Schedule not executing
- Verify the bridge is still running
- Check bridge logs for errors
- Ensure chat binding is established (send a message/event to bot/app first)

### 404 Not Found
- Verify the callback server is running on port 8788
- Check if another process is using the port

### No response in chat destination
- Ensure you've sent at least one message/event to the bot/app
- Check if `lastIncomingChatId` is logged in the bridge output
- Verify Gemini CLI is properly installed and configured

### Timezone issues
- Set the `TZ` environment variable to your timezone
- Example: `TZ=America/New_York npm run dev`
