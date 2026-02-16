#!/bin/bash

# Example: How Gemini CLI can interact with the Scheduler API
# This demonstrates the curl commands that Gemini would execute when asked to create schedules

BASE_URL="http://127.0.0.1:8788"
TOKEN="" # Set this if CALLBACK_AUTH_TOKEN is configured

# Helper function to add auth header if token is set
auth_header() {
  if [ -n "$TOKEN" ]; then
    echo "-H x-callback-token:$TOKEN"
  fi
}

echo "=== Gemini CLI Scheduler Integration Examples ==="
echo ""

# Example 1: User asks "Remind me to take a break in 30 minutes"
echo "Example 1: One-time reminder in 30 minutes"
echo "User: 'Remind me to take a break in 30 minutes'"
echo ""
RUN_AT=$(date -u -d "+30 minutes" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v+30M +"%Y-%m-%dT%H:%M:%SZ")
echo "Gemini executes:"
cat <<EOF
curl -X POST ${BASE_URL}/api/schedule \\
  -H "Content-Type: application/json" \\
  $(auth_header) \\
  -d '{
    "message": "Remind: Take a break! It has been 30 minutes.",
    "description": "Break reminder",
    "oneTime": true,
    "runAt": "${RUN_AT}"
  }'
EOF
echo ""
echo "---"
echo ""

# Example 2: User asks "Check my calendar every morning at 9am"
echo "Example 2: Daily calendar check at 9am"
echo "User: 'Check my calendar every morning at 9am and send me a summary'"
echo ""
echo "Gemini executes:"
cat <<EOF
curl -X POST ${BASE_URL}/api/schedule \\
  -H "Content-Type: application/json" \\
  $(auth_header) \\
  -d '{
    "message": "Check my calendar for today and provide a summary of all events",
    "description": "Daily calendar summary at 9am",
    "cronExpression": "0 9 * * *"
  }'
EOF
echo ""
echo "---"
echo ""

# Example 3: User asks "Every Friday at 5pm, remind me to review my weekly goals"
echo "Example 3: Weekly reminder on Fridays at 5pm"
echo "User: 'Every Friday at 5pm, remind me to review my weekly goals'"
echo ""
echo "Gemini executes:"
cat <<EOF
curl -X POST ${BASE_URL}/api/schedule \\
  -H "Content-Type: application/json" \\
  $(auth_header) \\
  -d '{
    "message": "Weekly reminder: Review your goals for this week. What did you accomplish? What needs more work?",
    "description": "Weekly goals review - Friday 5pm",
    "cronExpression": "0 17 * * 5"
  }'
EOF
echo ""
echo "---"
echo ""

# Example 4: User asks "What schedules do I have?"
echo "Example 4: List all schedules"
echo "User: 'What schedules do I have?'"
echo ""
echo "Gemini executes:"
cat <<EOF
curl ${BASE_URL}/api/schedule \\
  $(auth_header)
EOF
echo ""
echo "Then Gemini formats the response in a human-readable way."
echo ""
echo "---"
echo ""

# Example 5: User asks "Cancel my daily calendar check"
echo "Example 5: Cancel a specific schedule"
echo "User: 'Cancel my daily calendar check'"
echo ""
echo "Gemini first lists schedules, finds the one matching 'daily calendar', then:"
cat <<EOF
curl -X DELETE ${BASE_URL}/api/schedule/SCHEDULE_ID \\
  $(auth_header)
EOF
echo ""
echo "---"
echo ""

# Example 6: More complex recurring schedules
echo "Example 6: Complex recurring schedules"
echo ""

echo "Every 5 minutes:"
echo "  cronExpression: '*/5 * * * *'"
echo ""

echo "Every weekday at 8am:"
echo "  cronExpression: '0 8 * * 1-5'"
echo ""

echo "First day of every month at midnight:"
echo "  cronExpression: '0 0 1 * *'"
echo ""

echo "Every hour during work hours (9am-5pm) on weekdays:"
echo "  cronExpression: '0 9-17 * * 1-5'"
echo ""

echo "---"
echo ""

echo "=== Cron Expression Guide ==="
echo ""
echo "Format: minute hour day month weekday"
echo ""
echo "Field      Values"
echo "-------    ----------------"
echo "minute     0-59"
echo "hour       0-23"
echo "day        1-31"
echo "month      1-12"
echo "weekday    0-7 (0 or 7 is Sunday)"
echo ""
echo "Special characters:"
echo "  *   any value"
echo "  ,   value list separator (e.g., 1,3,5)"
echo "  -   range of values (e.g., 1-5)"
echo "  /   step values (e.g., */15 for every 15 minutes)"
echo ""

echo "=== Integration Notes ==="
echo ""
echo "1. Gemini CLI has access to the scheduler API endpoints through system prompts"
echo "2. When users ask to schedule something, Gemini:"
echo "   - Parses the natural language request"
echo "   - Determines if it's one-time (runAt) or recurring (cronExpression)"
echo "   - Converts time expressions to appropriate format"
echo "   - Calls the API with proper JSON payload"
echo "   - Confirms schedule creation to the user"
echo ""
echo "3. When scheduled jobs run:"
echo "   - The message is executed through a new Gemini CLI session"
echo "   - Gemini can use all its tools (calendar, file access, web search, etc.)"
echo "   - The response is automatically sent to the active Telegram/Slack destination"
echo ""
