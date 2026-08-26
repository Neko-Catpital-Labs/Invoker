#!/usr/bin/env bash
# Contract checks for scripts/bootstrap.sh (Node ensure → CLI install).
# Run from repo root.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOOTSTRAP="$REPO_ROOT/scripts/bootstrap.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f "$BOOTSTRAP" ]] || fail "missing $BOOTSTRAP"
[[ -x "$BOOTSTRAP" ]] || fail "bootstrap.sh must be executable"

bash -n "$BOOTSTRAP" || fail "bash -n failed"

must_contain() {
  local needle="$1"
  local hint="$2"
  if ! grep -qF -- "$needle" "$BOOTSTRAP"; then
    fail "$hint — missing: $needle"
  fi
}

must_contain '</dev/null' 'curl|bash-safe CLI calls must redirect stdin from /dev/null'
must_contain 'npx --yes @neko-catpital-labs/invoker-cli@latest install' 'bootstrap must delegate to invoker-cli install'
must_not_contain() {
  local needle="$1"
  local hint="$2"
  if grep -qF -- "$needle" "$BOOTSTRAP"; then
    fail "$hint — unexpected: $needle"
  fi
}

must_not_contain 'invoker-cli doctor --fix' 'bootstrap must not reimplement doctor'
must_not_contain 'invoker-cli setup --yes' 'bootstrap must not reimplement setup'

must_contain 'INSTALLED_NODE_MAJOR' 'bootstrap must re-check the Node major version after installing'
must_contain '$REQUIRED_NODE_MAJOR.x was installed, but' 'bootstrap must fail loudly on a post-install Node major mismatch'

help_out="$("$BOOTSTRAP" --help)"
printf '%s\n' "$help_out" | grep -qF 'npx @neko-catpital-labs/invoker-cli@latest install' \
  || fail '--help must mention npx install one-liner'

MOCK_BIN="$(mktemp -d)"
trap 'rm -rf "$MOCK_BIN"' EXIT

cat > "$MOCK_BIN/node" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "v18.0.0"
  exit 0
fi
if [ "$1" = "-e" ]; then
  echo "18"
  exit 0
fi
exit 1
EOF
chmod +x "$MOCK_BIN/node"

cat > "$MOCK_BIN/apt-get" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$MOCK_BIN/apt-get"

cat > "$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$MOCK_BIN/curl"

cat > "$MOCK_BIN/sudo" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$MOCK_BIN/sudo"

set +e
mismatch_out="$(PATH="$MOCK_BIN:$PATH" "$BOOTSTRAP" 2>&1)"
mismatch_rc=$?
set -e

[[ $mismatch_rc -ne 0 ]] || fail 'bootstrap must exit non-zero on a post-install Node major mismatch'
printf '%s\n' "$mismatch_out" | grep -qF 'was installed, but' \
  || fail 'bootstrap must report the post-install Node major mismatch'

rm -rf "$MOCK_BIN"
trap - EXIT

echo "OK: bootstrap contract"
