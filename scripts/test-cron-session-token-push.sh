#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUSH_SCRIPT="$REPO_ROOT/scripts/cron-session-token-push.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FAKE_HOME="$TMP_DIR/home"
mkdir -p "$FAKE_HOME"

CONFIG_PATH="$TMP_DIR/config.json"
cat > "$CONFIG_PATH" <<EOF
{
  "remoteTargets": {
    "fake_target": {"host": "do1.example", "user": "invoker", "sshKeyPath": "$TMP_DIR/fake_key", "port": 22},
    "incomplete_target": {"host": "", "user": "invoker", "sshKeyPath": ""}
  }
}
EOF
touch "$TMP_DIR/fake_key"

FAKE_BIN_DIR="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN_DIR"
CALL_LOG="$TMP_DIR/calls.log"
touch "$CALL_LOG"

cat > "$FAKE_BIN_DIR/ssh" <<'FAKESSH'
#!/usr/bin/env bash
echo "ssh $*" >> "$CALL_LOG"
remote_command="${@: -1}"
if [[ "$remote_command" == mkdir* ]]; then
  exit 0
fi
if [[ "$remote_command" == mv* ]]; then
  exit 0
fi
echo "unexpected fake ssh invocation: $remote_command" >&2
exit 2
FAKESSH
chmod +x "$FAKE_BIN_DIR/ssh"

cat > "$FAKE_BIN_DIR/scp" <<'FAKESCP'
#!/usr/bin/env bash
echo "scp $*" >> "$CALL_LOG"
exit 0
FAKESCP
chmod +x "$FAKE_BIN_DIR/scp"

run_push() {
  local target="$1"
  env \
    PATH="$FAKE_BIN_DIR:$PATH" \
    HOME="$FAKE_HOME" \
    CALL_LOG="$CALL_LOG" \
    INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH" \
    SESSION_TOKEN_PUSH_TARGET="$target" \
    SESSION_TOKEN_PUSH_SINCE="2026-08-24" \
    SESSION_TOKEN_PUSH_HOST_LABEL="testhost" \
    bash "$PUSH_SCRIPT"
}

run_push fake_target || fail "push must succeed against a complete target"

grep -qF "ssh " "$CALL_LOG" || fail "must invoke ssh"
grep -qF "scp " "$CALL_LOG" || fail "must invoke scp"

MKDIR_LINE="$(grep -F 'mkdir -p' "$CALL_LOG" || true)"
[[ -n "$MKDIR_LINE" ]] || fail "must mkdir -p the remote rollup dir"
echo "$MKDIR_LINE" | grep -qF '.invoker/session-rollups' || fail "mkdir must target ~/.invoker/session-rollups"

SCP_LINE="$(grep -F 'scp ' "$CALL_LOG" || true)"
echo "$SCP_LINE" | grep -qF '.invoker/session-rollups/testhost.json.tmp' || fail "scp must write to a .tmp file under ~/.invoker/session-rollups"

MV_LINE="$(grep -F 'mv ' "$CALL_LOG" || true)"
echo "$MV_LINE" | grep -qF '.invoker/session-rollups/testhost.json.tmp .invoker/session-rollups/testhost.json' || fail "mv must rename the .tmp file to the final <host>.json"

while IFS= read -r line; do
  echo "$line" | grep -qF '.invoker/session-rollups' || fail "no remote path other than ~/.invoker/session-rollups may be touched: $line"
done < "$CALL_LOG"

: > "$CALL_LOG"
set +e
missing_out="$(run_push does_not_exist 2>&1)"
missing_exit=$?
set -e
[[ "$missing_exit" -ne 0 ]] || fail "a missing remote target must exit non-zero"
echo "$missing_out" | grep -qiF "does_not_exist" || fail "the error message must name the missing target"
[[ ! -s "$CALL_LOG" ]] || fail "a missing target must not invoke ssh or scp at all"

echo "PASS: cron-session-token-push.sh writes only ~/.invoker/session-rollups/<host>.json via tmp+mv, and a missing target fails loudly"
