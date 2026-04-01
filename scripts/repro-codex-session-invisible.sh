#!/usr/bin/env bash
# Reproduction script for: Codex session conversations invisible in approval modal
#
# Problem: When Invoker runs "fix with Codex", the approval modal cannot display
# the Codex session conversation. Claude sessions work because:
#   1. Invoker passes --session-id <uuid> to Claude CLI
#   2. Claude writes ~/.claude/projects/<project>/<uuid>.jsonl
#   3. getClaudeSession() finds and parses it
#
# Codex has NO --session-id flag. It generates its own UUID and stores sessions
# at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl. Invoker's session
# lookup only searches ~/.claude/projects/, so Codex sessions are invisible.
#
# This script proves the gap by:
#   1. Running codex exec with a trivial prompt
#   2. Showing Codex created a session file with its own UUID
#   3. Showing Invoker's lookup path (~/.claude/projects/) has no matching file
#   4. Showing the Codex JSONL is parseable and contains conversation data
#
# Usage: bash scripts/repro-codex-session-invisible.sh
#
set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

echo "=== Repro: Codex session conversations invisible in approval modal ==="
echo ""

# ── Prerequisites ──────────────────────────────────────────────

if ! command -v codex &>/dev/null; then
  echo -e "${RED}SKIP: codex CLI not found in PATH${NC}"
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo -e "${RED}SKIP: python3 required for JSONL parsing${NC}"
  exit 1
fi

# ── Step 1: Record state before ────────────────────────────────

echo -e "${BOLD}==> Step 1: Recording ~/.codex/sessions/ state before run${NC}"

CODEX_SESSIONS_DIR="$HOME/.codex/sessions"
mkdir -p "$CODEX_SESSIONS_DIR"

# Count existing session files
BEFORE_COUNT=$(find "$CODEX_SESSIONS_DIR" -name '*.jsonl' 2>/dev/null | wc -l)
echo "    Session files before: $BEFORE_COUNT"

# ── Step 2: Run codex exec in a temp dir ───────────────────���───

echo ""
echo -e "${BOLD}==> Step 2: Running codex exec with trivial prompt${NC}"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-codex-sess.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

# Initialize a git repo (codex requires it)
git init "$WORK_DIR" >/dev/null 2>&1
git -C "$WORK_DIR" -c user.email='repro@local' -c user.name='repro' commit --allow-empty -m 'init' >/dev/null 2>&1

echo "    Working dir: $WORK_DIR"
echo "    Running: codex exec --full-auto \"echo 'hello from codex repro'\" ..."

set +e
CODEX_OUTPUT=$(cd "$WORK_DIR" && codex exec --full-auto "Run this exact shell command and nothing else: echo 'hello from codex repro'" 2>&1)
CODEX_EC=$?
set -e

echo "    codex exit code: $CODEX_EC"
if [[ $CODEX_EC -ne 0 ]]; then
  echo -e "${YELLOW}    Warning: codex exited non-zero. Output:${NC}"
  echo "$CODEX_OUTPUT" | head -10
  echo "    (continuing anyway — session file may still exist)"
fi

# ── Step 3: Find the new session file ──────────────────────────

echo ""
echo -e "${BOLD}==> Step 3: Finding new Codex session file${NC}"

AFTER_COUNT=$(find "$CODEX_SESSIONS_DIR" -name '*.jsonl' 2>/dev/null | wc -l)
echo "    Session files after: $AFTER_COUNT"

# Find the newest session file whose cwd matches our work dir
NEW_SESSION=""
CODEX_SESSION_UUID=""

# Search by mtime (newest first), check session_meta cwd
while IFS= read -r candidate; do
  FIRST_LINE=$(head -1 "$candidate" 2>/dev/null || true)
  CANDIDATE_CWD=$(echo "$FIRST_LINE" | python3 -c "
import json, sys
try:
    entry = json.loads(sys.stdin.read())
    print(entry.get('payload', {}).get('cwd', ''))
except: pass
" 2>/dev/null || true)
  if [[ "$CANDIDATE_CWD" == "$WORK_DIR" ]]; then
    NEW_SESSION="$candidate"
    CODEX_SESSION_UUID=$(echo "$FIRST_LINE" | python3 -c "
import json, sys
try:
    entry = json.loads(sys.stdin.read())
    print(entry.get('payload', {}).get('id', ''))
except: pass
" 2>/dev/null || true)
    break
  fi
done < <(find "$CODEX_SESSIONS_DIR" -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}')

if [[ -z "$NEW_SESSION" ]]; then
  echo -e "${RED}FAIL: No Codex session file found for cwd=$WORK_DIR${NC}"
  echo "    This may mean codex did not persist the session."
  exit 1
fi

echo "    Found session file: $NEW_SESSION"
echo "    Codex session UUID: $CODEX_SESSION_UUID"

# ── Step 4: Prove Invoker can't find it ────────────────────────

echo ""
echo -e "${BOLD}==> Step 4: Checking Invoker's lookup path (~/.claude/projects/)${NC}"

CLAUDE_PROJECTS="$HOME/.claude/projects"

echo "    Invoker searches: $CLAUDE_PROJECTS/*/<sessionId>.jsonl"
echo "    Looking for: ${CODEX_SESSION_UUID}.jsonl"

CLAUDE_MATCH=$(find "$CLAUDE_PROJECTS" -name "${CODEX_SESSION_UUID}.jsonl" 2>/dev/null || true)

if [[ -z "$CLAUDE_MATCH" ]]; then
  echo -e "    ${GREEN}Not found (as expected)${NC}"
else
  echo -e "    ${RED}Unexpectedly found: $CLAUDE_MATCH${NC}"
  exit 1
fi

# Also show that a random UUID (what Invoker generates) won't match either
FAKE_UUID=$(python3 -c "import uuid; print(uuid.uuid4())")
echo ""
echo "    Invoker generates its own random UUID: $FAKE_UUID"
echo "    This UUID has no relationship to Codex's UUID: $CODEX_SESSION_UUID"
echo "    They will never match."

# ── Step 5: Show the Codex session IS parseable ────────────────

echo ""
echo -e "${BOLD}==> Step 5: Proving Codex session data is parseable${NC}"

python3 << PYEOF
import json

path = "$NEW_SESSION"
user_msgs = []
assistant_msgs = []

with open(path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except:
            continue

        t = entry.get('type', '')
        payload = entry.get('payload', {})
        pt = payload.get('type', '')
        role = payload.get('role', '')

        # User messages
        if t == 'event_msg' and pt == 'user_message':
            msg = payload.get('message', '')
            if msg:
                user_msgs.append(msg[:100])

        # Assistant messages
        if t == 'response_item' and pt == 'message' and role == 'assistant':
            content = payload.get('content', [])
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'output_text':
                    text = block.get('text', '')
                    if text:
                        assistant_msgs.append(text[:100])

print(f"    User messages found: {len(user_msgs)}")
for i, msg in enumerate(user_msgs[:3]):
    print(f"      [{i}] {msg}")

print(f"    Assistant messages found: {len(assistant_msgs)}")
for i, msg in enumerate(assistant_msgs[:3]):
    print(f"      [{i}] {msg}")

if user_msgs or assistant_msgs:
    print()
    print("    Session data exists and is parseable!")
else:
    print()
    print("    Warning: No messages found (session may have been too short)")
PYEOF

# ── Summary ────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}=== BUG REPRODUCED ===${NC}"
echo ""
echo "  Codex stores sessions at:  ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl"
echo "  Invoker looks at:          ~/.claude/projects/*/<uuid>.jsonl"
echo ""
echo "  Codex session UUID:        $CODEX_SESSION_UUID"
echo "  Invoker would generate:    $FAKE_UUID (random, unrelated)"
echo ""
echo -e "  ${YELLOW}Root cause:${NC}"
echo "    1. Codex CLI has no --session-id flag — UUID is auto-generated internally"
echo "    2. Invoker generates its own random UUID that doesn't match Codex's"
echo "    3. getClaudeSession() only searches ~/.claude/projects/ (Claude's path)"
echo "    4. No getCodexSession() handler exists"
echo ""
echo -e "  ${YELLOW}Impact:${NC}"
echo "    Approval modal shows 'Could not load session' for all Codex fix sessions."
echo "    Users cannot audit what Codex did before approving or rejecting."
echo ""
echo -e "  ${YELLOW}Fix:${NC}"
echo "    1. After Codex exits, discover real session UUID from ~/.codex/sessions/"
echo "    2. Add Codex JSONL parser (different format from Claude's)"
echo "    3. Add getAgentSession() IPC handler that dispatches by agent name"
echo "    4. Update ApprovalModal to use agent-aware session loading"
exit 0
