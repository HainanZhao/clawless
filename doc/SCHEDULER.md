# Scheduler API Documentation

Clawless includes a cron scheduler API that allows you to schedule tasks to be executed through your local agent CLI at specific times or on a recurring basis (Gemini CLI by default).

## Overview

When a scheduled job runs:
1. The scheduled message is sent to a standalone local agent CLI session
2. The agent processes the message and generates a response
3. The response is sent back through the active interface adapter
4. The result appears in your active Telegram or Slack destination

Schedules are persisted to disk and reloaded on startup. By default the file is `~/.clawless/schedules.json` and can be overridden via `SCHEDULES_FILE_PATH`.

## API Endpoints

All scheduler endpoints are available at `http://127.0.0.1:8788/api/schedule`

### Authentication

If `CALLBACK_AUTH_TOKEN` is set in your configuration, include it in your requests:
- Header: `x-callback-token: <your-token>`
- Or: `Authorization: Bearer <your-token>`

### Create a Schedule

**POST** `/api/schedule`

Create a new recurring or one-time schedule.

#### Recurring Schedule Example

```bash
curl -X POST http://127.0.0.1:8788/api/schedule \
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
  "message": "The prompt to send to your local agent CLI",
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
curl -X POST http://127.0.0.1:8788/api/schedule \
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
  "message": "The prompt to send to your local agent CLI",
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
curl http://127.0.0.1:8788/api/schedule
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
curl http://127.0.0.1:8788/api/schedule/schedule_1707835800000_abc123
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
curl -X DELETE http://127.0.0.1:8788/api/schedule/schedule_1707835800000_abc123
```

**Response:**
```json
{
  "ok": true,
  "message": "Schedule removed"
}
```

### Update a Schedule

**PATCH** `/api/schedule/:id`

Update one or more fields on an existing schedule.

```bash
curl -X PATCH http://127.0.0.1:8788/api/schedule/schedule_1707835800000_abc123 \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Updated calendar summary",
    "cronExpression": "0 10 * * *"
  }'
```

**Request Body (all fields optional):**
```json
{
  "message": "Optional updated prompt",
  "description": "Optional updated description",
  "cronExpression": "Optional updated cron expression",
  "oneTime": false,
  "runAt": "Optional updated ISO timestamp",
  "active": true
}
```

**Response:**
```json
{
  "ok": true,
  "schedule": {
    "id": "schedule_1707835800000_abc123",
    "message": "Check my calendar",
    "description": "Updated calendar summary",
    "cronExpression": "0 10 * * *",
    "oneTime": false,
    "createdAt": "2026-02-13T10:00:00.000Z",
    "active": true,
    "lastRun": "2026-02-13T09:00:00.000Z"
  }
}
```

### Important: Always Use API for Mutations

- Create, update, and delete schedules only through the Scheduler API endpoints.
- Do not edit `~/.clawless/schedules.json` directly.
- The scheduler keeps live in-memory state and persists it; manual file edits can be overwritten or ignored until restart.

## Using with Your Local CLI (Default: Gemini)

The configured local CLI is aware of the scheduler API through the system prompt. With the default setup, you can ask Gemini to create schedules naturally:

**Examples:**

1. **"Remind me to take a break in 30 minutes"**
  - The agent will create a one-time schedule

2. **"Check my calendar every morning at 9am and send me a summary"**
  - The agent will create a recurring schedule with cron expression `0 9 * * *`

3. **"Every Friday at 5pm, remind me to review my weekly goals"**
  - The agent will create a recurring schedule with cron expression `0 17 * * 5`

4. **"List my scheduled tasks"**
  - The agent will query the schedule API and show you all active schedules

5. **"Cancel the calendar summary schedule"**
  - The agent will find and delete the matching schedule

## How It Works

1. When you ask the agent to create a schedule, it will:
   - Parse your request to determine timing (cron expression or specific date/time)
   - Call the scheduler API with appropriate parameters
   - Confirm the schedule was created

2. When the scheduled time arrives:
   - The scheduler executes the job
  - The message is sent to a new local CLI session
  - The agent processes the message (can use tools, access files, etc.)
  - The response is sent to the active interface destination (Telegram or Slack)

3. For recurring schedules:
   - The job runs according to the cron expression
   - Each execution is independent
   - The schedule continues until deleted

4. For one-time schedules:
   - The job runs once at the specified time
   - The schedule is automatically deleted after execution

## Notes

- Schedules are persisted to disk and reloaded on restart (`~/.clawless/schedules.json` by default)
- Ensure the active platform bot/app has received at least one inbound message/event so the bridge can bind a target destination for callbacks
- The timezone used for cron schedules is determined by the `TZ` environment variable (defaults to UTC)
- Scheduled jobs run in separate local CLI sessions, so they have access to all configured tools and MCP servers

## Troubleshooting

### Schedule not executing
- Check the bridge logs for error messages
- Verify the cron expression is valid using a cron expression tester
- Ensure the bridge is running continuously

### Results not appearing in chat
- Send at least one message/event to your active bot/app first to establish the chat binding
- Check if `lastIncomingChatId` is set in the logs

### Authentication errors
- If `CALLBACK_AUTH_TOKEN` is set, make sure to include it in the request headers
- Use either `x-callback-token` or `Authorization: Bearer` header

## Environment Variables

No additional environment variables are required. The scheduler uses the existing callback server configuration:

- `CALLBACK_HOST` - Host for callback server (default: 127.0.0.1)
- `CALLBACK_PORT` - Port for callback server (default: 8788)
- `CALLBACK_AUTH_TOKEN` - Optional authentication token
- `TZ` - Timezone for cron schedules (default: UTC)
