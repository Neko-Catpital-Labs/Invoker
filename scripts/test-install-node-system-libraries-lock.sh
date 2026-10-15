#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
marker="$tmp/stopped"

cat > "$tmp/systemctl" << 'EOF'
#!/bin/bash
exit 0
EOF

cat > "$tmp/sudo" << EOF
#!/bin/bash
if [ "\$1" = "-n" ] && [ "\$2" = "true" ]; then
  exit 0
fi
if [ "\$1" = "-n" ] && [ "\$2" = "systemctl" ]; then
  touch "$marker"
  exit 0
fi
if [ "\$1" = "-n" ] && [ "\$2" = "apt-get" ]; then
  if [ ! -f "$marker" ]; then
    echo "Waiting for cache lock: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1856 (unattended-upgr)" >&2
    echo "E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), is another process using it?" >&2
    exit 100
  fi
  exit 0
fi
exit 1
EOF
chmod +x "$tmp/sudo" "$tmp/systemctl"

PATH="$tmp:$PATH" \
CI_INSTALL_PACKAGES=libatomic1 \
CI_INSTALL_PROBE_SONAME=libdefinitely-missing.so.0 \
CI_INSTALL_PROBE_COMMANDS= \
CI_INSTALL_APT_LOCK_TIMEOUT_SECS=1 \
CI_INSTALL_APT_LOCK_RETRIES=2 \
CI_INSTALL_APT_LOCK_RETRY_SLEEP_SECS=0 \
  bash "$root/scripts/ci/install-node-system-libraries.sh"

test -f "$marker"
echo "install-node-system-libraries lock: pass"
