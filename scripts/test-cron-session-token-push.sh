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
    "remote_digital_ocean_1": {"host": "do1.example", "user": "invoker", "sshKeyPath": "$TMP_DIR/fake_key", "port": 22},
    "incomplete_target": {"host": "", "user": "invoker", "sshKeyPath": ""}
  }
}
EOF
touch "$TMP_DIR/fake_key"

REMOTE_FS="$TMP_DIR/remote_fs"
CALLS_LOG="$TMP_DIR/calls.log"
mkdir -p "$REMOTE_FS"

FAKE_BIN_DIR="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN_DIR"

cat > "$FAKE_BIN_DIR/ssh" <<'FAKESSH'
#!/usr/bin/env bash
remote_command="${@: -1}"
echo "SSH $remote_command" >> "$CALLS_LOG"
expanded="${remote_command//\~/$REMOTE_FS}"
eval "$expanded"
FAKESSH
chmod +x "$FAKE_BIN_DIR/ssh"

cat > "$FAKE_BIN_DIR/scp" <<'FAKESCP'
#!/usr/bin/env bash
args=("$@")
count=${#args[@]}
dest="${args[$((count - 1))]}"
src="${args[$((count - 2))]}"
echo "SCP $src -> $dest" >> "$CALLS_LOG"
remote_path="${dest#*:}"
remote_path="${remote_path//\~/$REMOTE_FS}"
mkdir -p "$(dirname "$remote_path")"
cp "$src" "$remote_path"
FAKESCP
chmod +x "$FAKE_BIN_DIR/scp"

export PATH="$FAKE_BIN_DIR:$PATH"
export INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH"
export REMOTE_FS
export CALLS_LOG
export HOME="$FAKE_HOME"

HOST_LABEL="$(python3 -c 'import socket; print(socket.gethostname())')"

"$PUSH_SCRIPT" || fail "cron-session-token-push.sh must exit 0 against a configured target"

[[ -f "$CALLS_LOG" ]] || fail "expected ssh/scp to be invoked"

call_count="$(wc -l < "$CALLS_LOG" | tr -d ' ')"
[[ "$call_count" -eq 3 ]] || fail "expected exactly 3 ssh/scp calls, got $call_count: $(cat "$CALLS_LOG")"

grep -qF "SSH mkdir -p ~/.invoker/session-rollups" "$CALLS_LOG" || fail "must mkdir -p the session-rollups dir first"
grep -qF -- "-> invoker@do1.example:~/.invoker/session-rollups/${HOST_LABEL}.json.tmp" "$CALLS_LOG" || fail "must scp to a .tmp file under session-rollups"
grep -qF "SSH mv ~/.invoker/session-rollups/${HOST_LABEL}.json.tmp ~/.invoker/session-rollups/${HOST_LABEL}.json" "$CALLS_LOG" || fail "must mv the .tmp file to its final name on the remote"

[[ -f "$REMOTE_FS/.invoker/session-rollups/${HOST_LABEL}.json" ]] || fail "final report file must exist on the remote"
[[ ! -f "$REMOTE_FS/.invoker/session-rollups/${HOST_LABEL}.json.tmp" ]] || fail "the .tmp file must not remain after the rename"

written_paths="$(find "$REMOTE_FS" -type f)"
written_count="$(echo "$written_paths" | wc -l | tr -d ' ')"
[[ "$written_count" -eq 1 ]] || fail "exactly one file must exist on the remote, found: $written_paths"

python3 -c "import json; json.load(open('$REMOTE_FS/.invoker/session-rollups/${HOST_LABEL}.json'))" \
  || fail "the pushed remote file must be valid JSON"

rm -f "$CALLS_LOG"

set +e
out="$(SESSION_TOKEN_PUSH_TARGET="does_not_exist" "$PUSH_SCRIPT" 2>&1)"
missing_exit=$?
set -e
[[ "$missing_exit" -ne 0 ]] || fail "a missing/unconfigured target must exit non-zero"
echo "$out" | grep -qF "does_not_exist" || fail "the failure message must name the missing target id"
[[ ! -f "$CALLS_LOG" ]] || fail "a missing target must fail before any ssh/scp call is attempted"

echo "OK: cron-session-token-push.sh contract checks passed"
