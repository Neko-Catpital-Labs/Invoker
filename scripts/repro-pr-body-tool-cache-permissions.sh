#!/usr/bin/env bash

set -euo pipefail

fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/pr-body-tool-cache-permissions.XXXXXX")"
tool_cache="${fixture_root}/tool cache"
node_cache="${tool_cache}/node"
requested_node="${node_cache}/24.19.0"

cleanup() {
  chmod -R u+rwX -- "${fixture_root}" 2>/dev/null || true
  rm -rf -- "${fixture_root}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p -- "${node_cache}"

# Model a cache root repaired for the current account while its existing Node
# subtree still has the non-writable mode that foreign ownership exposes.
chmod u+rwx -- "${tool_cache}"
chmod 0555 -- "${node_cache}"

if mkdir -- "${requested_node}" 2>"${fixture_root}/shallow-repair.stderr"; then
  echo "ERROR: shallow root-only repair unexpectedly created node/24.19.0" >&2
  exit 1
fi

echo "REPRODUCED: shallow root-only repair cannot create node/24.19.0"

# Use mode repair as a sudo-free stand-in for recursively restoring ownership
# to the current account. The workflow performs the corresponding chown.
chmod -R u+rwX -- "${node_cache}"

if ! mkdir -- "${requested_node}"; then
  echo "ERROR: nested Node cache repair could not create node/24.19.0" >&2
  exit 1
fi

echo "CORRECTED: nested Node cache repair can create node/24.19.0"
