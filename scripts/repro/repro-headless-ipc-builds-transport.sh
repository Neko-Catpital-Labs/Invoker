#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-headless-ipc-builds-transport.XXXXXX")"
TRANSPORT_DIST="$ROOT/packages/transport/dist"
BACKUP_DIST=""
fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

cleanup() {
  rm -rf "$TRANSPORT_DIST"
  if [ -n "$BACKUP_DIST" ] && [ -d "$BACKUP_DIST" ]; then
    mv "$BACKUP_DIST" "$TRANSPORT_DIST"
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

if [ -d "$TRANSPORT_DIST" ]; then
  BACKUP_DIST="$TMP/original-transport-dist"
  mv "$TRANSPORT_DIST" "$BACKUP_DIST"
fi

mkdir -p "$TMP/bin"
cat > "$TMP/bin/pnpm" <<'PNPM'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_PNPM_LOG:?}"
[ "$1" = "--filter" ] && [ "$2" = "@invoker/transport" ] && [ "$3" = "build" ]
mkdir -p packages/transport/dist
cat > packages/transport/dist/index.js <<'JS'
export class IpcBus {
  async ready() {}
  async request(channel) {
    if (channel === 'headless.run') {
      return { workflowId: 'wf-built-transport' };
    }
    throw new Error(`unexpected channel ${channel}`);
  }
  disconnect() {}
}
JS
PNPM
chmod +x "$TMP/bin/pnpm"
printf 'name: repro\n' > "$TMP/plan.yaml"
export FAKE_PNPM_LOG="$TMP/pnpm.log"

out="$(
  PATH="$TMP/bin:$PATH" \
  INVOKER_HEADLESS_REQUIRE_EXISTING_OWNER=1 \
  node scripts/headless-ipc.js exec --no-track -- run "$TMP/plan.yaml" 2>&1
)" || fail "headless-ipc exited non-zero" "$out"

grep -q -- "--filter @invoker/transport build" "$FAKE_PNPM_LOG" \
  || fail "transport build was not invoked" "$(cat "$FAKE_PNPM_LOG")"
echo "$out" | grep -q "wf-built-transport" \
  || fail "headless-ipc did not use rebuilt transport" "$out"

echo "[repro] passed"
