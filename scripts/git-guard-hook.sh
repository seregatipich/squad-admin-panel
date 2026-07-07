#!/usr/bin/env bash
# git-guard-hook.sh — PreToolUse adapter for scripts/git-guard.sh.
#
# Shared by Claude Code (.claude/settings.json) and Codex (.codex/hooks.json):
# both agents send a JSON object with `tool_input.command` on stdin and treat
# exit code 2 + stderr as "deny with reason". Non-git commands pass through.

set -u

input=$(cat)

if command -v jq >/dev/null 2>&1; then
  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
else
  cmd=$(printf '%s' "$input" | python3 -c '
import json, sys
try:
    value = json.load(sys.stdin).get("tool_input", {}).get("command", "")
except Exception:
    value = ""
print(value if isinstance(value, str) else "")
' 2>/dev/null)
fi

[ -z "${cmd:-}" ] && exit 0

exec "$(cd "$(dirname "$0")" && pwd)/git-guard.sh" check-command "$cmd"
