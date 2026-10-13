#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ci-install-node-system-libraries.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin"

cat > "$TMP_DIR/bin/id" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "-u" ]; then
  printf '0\n'
  exit 0
fi
/usr/bin/id "$@"
EOF

cat > "$TMP_DIR/bin/apt-get" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
log="${APT_GET_CALL_LOG:?APT_GET_CALL_LOG is required}"
printf '%s\n' "$*" >> "$log"
case "${1:-}" in
  update)
    exit 0
    ;;
  install)
    attempts_file="${APT_GET_INSTALL_ATTEMPTS:?APT_GET_INSTALL_ATTEMPTS is required}"
    attempts=0
    if [ -f "$attempts_file" ]; then
      attempts="$(cat "$attempts_file")"
    fi
    attempts=$((attempts + 1))
    printf '%s\n' "$attempts" > "$attempts_file"
    if [ "$attempts" -eq 1 ]; then
      echo 'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 2300 (apt-get)' >&2
      echo 'E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), is another process using it?' >&2
      exit 100
    fi
    exit 0
    ;;
esac
echo "unexpected apt-get invocation: $*" >&2
exit 2
EOF

chmod +x "$TMP_DIR/bin/id" "$TMP_DIR/bin/apt-get"

APT_GET_CALL_LOG="$TMP_DIR/apt-get.calls"
APT_GET_INSTALL_ATTEMPTS="$TMP_DIR/install-attempts"
export APT_GET_CALL_LOG APT_GET_INSTALL_ATTEMPTS

PATH="$TMP_DIR/bin:$PATH" \
  CI_INSTALL_PACKAGES="fake-package" \
  CI_INSTALL_PROBE_COMMANDS="missing-native-tool" \
  CI_INSTALL_APT_LOCK_RETRY_DELAY_SECONDS=0 \
  "$ROOT/scripts/ci/install-node-system-libraries.sh"

if [ "$(cat "$APT_GET_INSTALL_ATTEMPTS")" != "2" ]; then
  echo "expected apt-get install to retry once after a transient dpkg lock" >&2
  cat "$APT_GET_CALL_LOG" >&2
  exit 1
fi

echo "ci-install-node-system-libraries-ok"
