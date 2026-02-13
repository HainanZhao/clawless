# Scheduler API Documentation

The Agent Bridge now includes a cron scheduler API that allows you to schedule tasks to be executed through Gemini CLI at specific times or on a recurring basis.

## Overview

When a scheduled job runs:
1. The scheduled message is sent to a standalone Gemini CLI session
2. Gemini processes the message and generates a response
3. The response is sent back to your Telegram bot
4. The result appears in your Telegram chat

Schedules are persisted to disk and reloaded on startup. By default the file is `~/.gemini-bridge/schedules.json` and can be overridden via `SCHEDULES_FILE_PATH`.

## API Endpoints

All scheduler endpoints are available at `http://127.0.0.1:8787/api/schedule`

### Authentication

If `CALLBACK_AUTH_TOKEN` is set in your configuration, include it in your requests:
- Header: `x-callback-token: <your-token>`
- Or: `Authorization: Bearer <your-token>`

### Create a Schedule

**POST** `/api/schedule`

Create a new recurring or one-time schedule.

#### Recurring Schedule Example

```bash
curl -X POST http://127.0.0.1:8787/api/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Check my calendar and send me a summary",
    "description": "Daily calendar summary",
    "cronExpression": "0 9 * * *"
  }'
```

**Request Body:**
```json
{
  "message": "The prompt to send to Gemini CLI",
  "description": "Optional description of the schedule",
  "cronExpression": "0 9 * * *"
}
```

**Cron Expression Format:**
```
* * * * *
│ │ │ │ │
│ │ │ │ └─ Day of week (0-7, both 0 and 7 are Sunday)
│ │ │ └─── Month (1-12)
│ │ └───── Day of month (1-31)
│ └─────── Hour (0-23)
└───────── Minute (0-59)
```

**Common Cron Examples:**
- `0 9 * * *` - Daily at 9:00 AM
- `0 */6 * * *` - Every 6 hours
- `*/30 * * * *` - Every 30 minutes
- `0 9 * * 1-5` - Weekdays at 9:00 AM
- `0 0 1 * *` - First day of every month at midnight

#### One-Time Schedule Example

```bash
curl -X POST http://127.0.0.1:8787/api/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Remind me to take a break",
    "description": "Break reminder",
    "oneTime": true,
    "runAt": "2026-02-13T15:30:00Z"
  }'
```

**Request Body:**
```json
{
  "message": "The prompt to send to Gemini CLI",
  "description": "Optional description",
  "oneTime": true,
  "runAt": "2026-02-13T15:30:00Z"
}
```

**Response:**
```json
{
  "ok": true,
  "schedule": {
    "id": "schedule_1707835800000_abc123",
    "message": "Check my calendar and send me a summary",
    "description": "Daily calendar summary",
    "cronExpression": "0 9 * * *",
    "oneTime": false,
    "createdAt": "2026-02-13T10:00:00.000Z",
    "active": true
  }
}
```

### List Schedules

**GET** `/api/schedule`

List all active schedules.

```bash
curl http://127.0.0.1:8787/api/schedule
```

**Response:**
```json
{
  "ok": true,
  "schedules": [
    {
      "id": "schedule_1707835800000_abc123",
      "message": "Check my calendar",
      "description": "Daily calendar summary",
      "cronExpression": "0 9 * * *",
      "oneTime": false,
      "createdAt": "2026-02-13T10:00:00.000Z",
      "active": true,
      "lastRun": "2026-02-13T09:00:00.000Z"
    }
  ]
}
```

### Get a Specific Schedule

**GET** `/api/schedule/:id`

Get details of a specific schedule.

```bash
curl http://127.0.0.1:8787/api/schedule/schedule_1707835800000_abc123
```

**Response:**
```json
{
  "ok": true,
  "schedule": {
    "id": "schedule_1707835800000_abc123",
    "message": "Check my calendar",
    "description": "Daily calendar summary",
    "cronExpression": "0 9 * * *",
    "oneTime": false,
    "createdAt": "2026-02-13T10:00:00.000Z",
    "active": true,
    "lastRun": "2026-02-13T09:00:00.000Z"
  }
}
```

### Delete a Schedule

**DELETE** `/api/schedule/:id`

Remove a schedule. This stops any future executions.

```bash
curl -X DELETE http://127.0.0.1:8787/api/schedule/schedule_1707835800000_abc123
```

**Response:**
```json
{
  "ok": true,
  "message": "Schedule removed"
}
```

## Using with Gemini CLI

The Gemini CLI is aware of the scheduler API through the system prompt. You can ask Gemini to create schedules naturally:

**Examples:**

1. **"Remind me to take a break in 30 minutes"**
   - Gemini will create a one-time schedule

2. **"Check my calendar every morning at 9am and send me a summary"**
   - Gemini will create a recurring schedule with cron expression `0 9 * * *`

3. **"Every Friday at 5pm, remind me to review my weekly goals"**
   - Gemini will create a recurring schedule with cron expression `0 17 * * 5`

4. **"List my scheduled tasks"**
   - Gemini will query the schedule API and show you all active schedules

5. **"Cancel the calendar summary schedule"**
   - Gemini will find and delete the matching schedule

## How It Works

1. When you ask Gemini to create a schedule, it will:
   - Parse your request to determine timing (cron expression or specific date/time)
   - Call the scheduler API with appropriate parameters
   - Confirm the schedule was created

2. When the scheduled time arrives:
   - The scheduler executes the job
   - The message is sent to a new Gemini CLI session
   - Gemini processes the message (can use tools, access files, etc.)
   - The response is sent to your Telegram chat

3. For recurring schedules:
   - The job runs according to the cron expression
   - Each execution is independent
   - The schedule continues until deleted

4. For one-time schedules:
   - The job runs once at the specified time
   - The schedule is automatically deleted after execution

## Notes

- Schedules are stored in memory and will be lost if the bridge restarts
- Make sure your Telegram bot has received at least one message so it knows where to send results
- The timezone used for cron schedules is determined by the `TZ` environment variable (defaults to UTC)
- Scheduled jobs run in separate Gemini CLI sessions, so they have access to all configured tools and MCP servers

## Troubleshooting

### Schedule not executing
- Check the bridge logs for error messages
- Verify the cron expression is valid using a cron expression tester
- Ensure the bridge is running continuously

### Results not appearing in Telegram
- Send at least one message to your bot first to establish the chat binding
- Check if `lastIncomingChatId` is set in the logs

### Authentication errors
- If `CALLBACK_AUTH_TOKEN` is set, make sure to include it in the request headers
- Use either `x-callback-token` or `Authorization: Bearer` header

## Environment Variables

No additional environment variables are required. The scheduler uses the existing callback server configuration:

- `CALLBACK_HOST` - Host for callback server (default: 127.0.0.1)
- `CALLBACK_PORT` - Port for callback server (default: 8787)
- `CALLBACK_AUTH_TOKEN` - Optional authentication token
- `TZ` - Timezone for cron schedules (default: UTC)
