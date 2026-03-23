#!/usr/bin/env bash
set -euo pipefail

# Verify DigitalOcean SSH key-based E2E execution.
#
# Required env vars:
#   INVOKER_DO_HOST     - remote host IP/hostname
#   INVOKER_DO_USER     - SSH user (e.g. root)
#   INVOKER_DO_SSH_KEY  - path to SSH private key file
#
# Usage:
#   INVOKER_DO_HOST="178.128.181.133" \
#   INVOKER_DO_USER="root" \
#   INVOKER_DO_SSH_KEY="$HOME/.ssh/id_do" \
#   bash scripts/verify-digitalocean-e2e.sh

: "${INVOKER_DO_HOST:?missing INVOKER_DO_HOST env var}"
: "${INVOKER_DO_USER:?missing INVOKER_DO_USER env var}"
: "${INVOKER_DO_SSH_KEY:?missing INVOKER_DO_SSH_KEY env var}"

if [ ! -f "$INVOKER_DO_SSH_KEY" ]; then
  echo "ERROR: SSH key file not found: $INVOKER_DO_SSH_KEY" >&2
  exit 1
fi

echo "=== DigitalOcean E2E Verification ==="
echo "Host: $INVOKER_DO_HOST"
echo "User: $INVOKER_DO_USER"
echo "Key:  $INVOKER_DO_SSH_KEY"
echo

echo "--- Step 1: Test SSH connectivity ---"
ssh -i "$INVOKER_DO_SSH_KEY" \
    -p 22 \
    -o StrictHostKeyChecking=accept-new \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    "${INVOKER_DO_USER}@${INVOKER_DO_HOST}" \
    "echo 'SSH connection successful'; uname -a"

echo
echo "--- Step 2: Run remote command ---"
REMOTE_OUTPUT=$(ssh -i "$INVOKER_DO_SSH_KEY" \
    -p 22 \
    -o StrictHostKeyChecking=accept-new \
    -o BatchMode=yes \
    "${INVOKER_DO_USER}@${INVOKER_DO_HOST}" \
    "echo 'invoker-e2e-test-ok'; hostname; date -u")

echo "$REMOTE_OUTPUT"

if echo "$REMOTE_OUTPUT" | grep -q "invoker-e2e-test-ok"; then
  echo
  echo "=== E2E PASSED ==="
  exit 0
else
  echo
  echo "=== E2E FAILED: expected marker not found in output ===" >&2
  exit 1
fi
