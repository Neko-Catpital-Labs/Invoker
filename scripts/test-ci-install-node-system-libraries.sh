#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ci-install-node-system-libraries.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

FAKE_BIN="$TMP/bin"
LOG="$TMP/apt.log"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/sudo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "-n" && "${2:-}" == "true" ]]; then
  exit 0
fi
if [[ "${1:-}" == "-n" ]]; then
  shift
  exec "$@"
fi
echo "unexpected sudo invocation: $*" >&2
exit 99
EOF
chmod +x "$FAKE_BIN/sudo"

cat > "$FAKE_BIN/apt-get" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${APT_LOG:?}"
has_lock_timeout=0
for arg in "$@"; do
  if [[ "$arg" == DPkg::Lock::Timeout=* ]]; then
    has_lock_timeout=1
  fi
done
if [[ " $* " == *" install "* && "$has_lock_timeout" -ne 1 ]]; then
  echo "E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1724 (unattended-upgr)" >&2
  echo "E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), is another process using it?" >&2
  exit 100
fi
exit 0
EOF
chmod +x "$FAKE_BIN/apt-get"

APT_LOG="$LOG" \
GITHUB_ENV="$TMP/github-env" \
PATH="$FAKE_BIN:/usr/bin:/bin" \
CI_INSTALL_PACKAGES="example-package" \
CI_INSTALL_PROBE_COMMANDS="missing-tool" \
CI_INSTALL_NO_APT_ERROR="apt-get unavailable" \
CI_INSTALL_SUDO_UNAVAILABLE_ERROR="sudo unavailable" \
bash "$ROOT/scripts/ci/install-node-system-libraries.sh"

grep -F -- "-o DPkg::Lock::Timeout=120 update" "$LOG" >/dev/null
grep -F -- "-o DPkg::Lock::Timeout=120 install -y example-package" "$LOG" >/dev/null

echo "ci install-node-system-libraries lock-timeout repro passed"
