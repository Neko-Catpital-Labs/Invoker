#!/usr/bin/env bash
# Contract checks for scripts/ci/install-node-system-libraries.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$REPO_ROOT/scripts/ci/install-node-system-libraries.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f "$INSTALLER" ]] || fail "missing $INSTALLER"
bash -n "$INSTALLER" || fail "bash -n failed"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ci-install-node-system-libraries.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/id" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-u" ]; then
  echo 1000
  exit 0
fi
exec /usr/bin/id "$@"
STUB
chmod +x "$TMP/id"

cat > "$TMP/sudo" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-n" ] && [ "${2:-}" = "true" ]; then
  exit 0
fi
if [ "$1" = "-n" ]; then
  shift
  exec "$@"
fi
exit 1
STUB
chmod +x "$TMP/sudo"

cat > "$TMP/apt-get" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "update" ]; then
  exit 0
fi
if [ "$1" = "install" ]; then
  count_file="${TMPDIR:?}/apt-install-count"
  count=0
  if [ -f "$count_file" ]; then
    count="$(cat "$count_file")"
  fi
  count=$((count + 1))
  printf '%s' "$count" > "$count_file"
  if [ "$count" -eq 1 ]; then
    echo 'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1742 (unattended-upgr)' >&2
    echo 'E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), is another process using it?' >&2
    exit 100
  fi
  exit 0
fi
exit 2
STUB
chmod +x "$TMP/apt-get"

PATH="$TMP:$PATH" \
TMPDIR="$TMP" \
CI_INSTALL_PACKAGES="example-package" \
CI_INSTALL_PROBE_COMMANDS="missing-ci-tool" \
CI_INSTALL_SUDO_UNAVAILABLE_ERROR="missing" \
CI_INSTALL_APT_LOCK_RETRIES=2 \
CI_INSTALL_APT_LOCK_RETRY_SLEEP_SECS=0 \
  bash "$INSTALLER" > "$TMP/out" 2>&1 \
  || fail "installer should retry a transient apt/dpkg lock"

[[ "$(cat "$TMP/apt-install-count")" = "2" ]] || fail "installer should retry apt-get install once after a lock"
grep -qF 'apt-get hit a dpkg/apt lock' "$TMP/out" \
  || fail "installer should explain the apt lock retry"

echo "OK: ci install-node-system-libraries contract"
