#!/usr/bin/env bash
set -euo pipefail

# Contract test for fleet-ssh.sh, using a fake `ssh` binary on PATH instead
# of real network access, so it's fast, deterministic, and portable.
#
# Regression coverage for a real bug this test suite caught: the original
# implementation ran `set -e` inside each backgrounded per-host subshell, so
# a failing remote command (nonzero exit) killed the subshell before it
# could write its own exit code to the output file -- the host's output
# block silently never printed. Proven live against remote_digital_ocean_1
# with `exit 42`: before the fix, `fleet-ssh.sh --hosts ... "exit 42"`
# produced zero stdout; after the fix, it printed the header with exit=42.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FLEET_SSH="$REPO_ROOT/scripts/fleet-ssh.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# --- fake config.json with two targets ---
CONFIG_PATH="$TMP_DIR/config.json"
cat > "$CONFIG_PATH" <<EOF
{
  "remoteTargets": {
    "host_a": {"host": "host-a.example", "user": "invoker", "sshKeyPath": "$TMP_DIR/fake_key", "port": 22},
    "host_b": {"host": "host-b.example", "user": "invoker", "sshKeyPath": "$TMP_DIR/fake_key", "port": 22},
    "incomplete_target": {"host": "", "user": "invoker", "sshKeyPath": ""}
  }
}
EOF
touch "$TMP_DIR/fake_key"

# --- fake ssh: ignores connection args, runs the last arg as the "remote"
#     command locally, so we can control success/failure/output deterministically ---
FAKE_BIN_DIR="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN_DIR"
cat > "$FAKE_BIN_DIR/ssh" <<'FAKESSH'
#!/usr/bin/env bash
remote_command="${@: -1}"
if [[ "$remote_command" == *"exit 42"* ]]; then
  echo "before the failure"
  exit 42
fi
echo "ran: $remote_command"
exit 0
FAKESSH
chmod +x "$FAKE_BIN_DIR/ssh"

export PATH="$FAKE_BIN_DIR:$PATH"
export INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH"

# --- test: --list parses config without invoking ssh at all ---
list_out="$("$FLEET_SSH" --list)"
echo "$list_out" | grep -qF "host_a" || fail "--list must show host_a"
echo "$list_out" | grep -qF "host_b" || fail "--list must show host_b"
echo "$list_out" | grep -qF "incomplete_target" && fail "--list must skip a target missing host/user/sshKeyPath"

# --- test: runs against all configured hosts by default ---
out="$("$FLEET_SSH" "echo hi" 2>&1)" || true
echo "$out" | grep -qF "=== host_a (exit=0) ===" || fail "must run against host_a by default"
echo "$out" | grep -qF "=== host_b (exit=0) ===" || fail "must run against host_b by default"
echo "$out" | grep -qF "ran: echo hi" || fail "must show the fake ssh's real output"

# --- test: --hosts filters to only the named target ---
out="$("$FLEET_SSH" --hosts host_a "echo hi" 2>&1)" || true
echo "$out" | grep -qF "host_a" || fail "--hosts host_a must include host_a"
echo "$out" | grep -qF "host_b" && fail "--hosts host_a must NOT include host_b"

# --- regression test: a failing remote command's exit code and output must
#     still be captured and printed, not silently dropped ---
out="$("$FLEET_SSH" --hosts host_a "exit 42" 2>&1)" || true
echo "$out" | grep -qF "=== host_a (exit=42) ===" || fail "a failing remote command's exit code must be captured and printed (regression: set -e killed the subshell before it could)"
echo "$out" | grep -qF "before the failure" || fail "a failing remote command's stdout before the failure must still be shown"

# --- test: fleet-ssh.sh itself exits non-zero when any host fails ---
set +e
"$FLEET_SSH" --hosts host_a "exit 42" > /dev/null 2>&1
own_exit=$?
set -e
[[ "$own_exit" -ne 0 ]] || fail "fleet-ssh.sh must exit non-zero when a remote host command fails"

echo "OK: fleet-ssh.sh contract checks passed"
