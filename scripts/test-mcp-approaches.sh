#!/bin/bash
# Test script to verify MCP tool access in different modes
# Usage: ./scripts/test-mcp-approaches.sh

set -e

echo "=== Testing MCP Tool Access ==="
echo ""

# Test 1: Normal Gemini CLI mode (should have MCP tools)
echo "--- Test 1: Normal Gemini CLI (non-ACP) ---"
echo "This should show MCP tools available"
echo "exit" | timeout 30 gemini 2>&1 | head -30 || echo "Timeout or exit"
echo ""

# Test 2: ACP mode with --allowed-mcp-server-names (THE FIX)
echo "--- Test 2: ACP mode WITH allowed MCP server names (FIX) ---"
echo 'list tools' | timeout 45 gemini --experimental-acp --approval-mode=yolo --allowed-mcp-server-names=gitlab,context7 2>&1 | grep -E "(gitlab|context7|Tools:|Available tools)" | head -20 || echo "Done"
echo ""

# Test 3: ACP mode WITHOUT allowed MCP server names (broken)
echo "--- Test 3: ACP mode WITHOUT allowed MCP server names (BROKEN) ---"
echo 'list tools' | timeout 45 gemini --experimental-acp --approval-mode=yolo 2>&1 | grep -E "(gitlab|context7|Tools:|Available tools)" | head -20 || echo "Done"
echo ""

# Test 4: Check MCP servers in settings
echo "--- Test 4: Gemini MCP settings ---"
cat ~/.gemini/settings.json | jq '.mcpServers // {}' 2>/dev/null || echo "No mcpServers found"
echo ""

echo "=== Summary ==="
echo "The fix adds --allowed-mcp-server-names=gitlab,context7 to ACP args"
echo "This allows Gemini CLI to use MCP tools configured in ~/.gemini/settings.json"
echo "=== Done ==="
