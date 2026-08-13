#!/usr/bin/env bash
set -euo pipefail

has_libatomic() {
  ldconfig -p 2>/dev/null | grep -q 'libatomic\.so\.1' \
    || [[ -e /usr/lib/x86_64-linux-gnu/libatomic.so.1 ]] \
    || [[ -e /lib/x86_64-linux-gnu/libatomic.so.1 ]]
}

if has_libatomic; then
  exit 0
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "::warning::apt-get is unavailable; skipping libatomic1 provisioning."
  exit 0
fi

sudo_cmd=()
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo_cmd=(sudo)
  else
    echo "::error::libatomic.so.1 is missing and apt-get requires root or passwordless sudo."
    exit 1
  fi
fi

"${sudo_cmd[@]}" apt-get update
"${sudo_cmd[@]}" apt-get install -y libatomic1
