set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SCRIPT="scripts/deploy-do1.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }

bash -n "$SCRIPT" || fail "$SCRIPT is not valid bash"

grep -qF 'npm publish' "$SCRIPT" && fail "$SCRIPT must never call npm publish"

BEFORE_LINE="$(grep -n '^grep -qF "\[MENTION_ROUTE\]"' "$SCRIPT" | head -n1 | cut -d: -f1)"
[ -n "$BEFORE_LINE" ] || fail "could not find the surfaces-dist check that gates the build/test steps"

REFRESH_LINE="$(grep -n 'npm-global refresh complete' "$SCRIPT" | head -n1 | cut -d: -f1)"
[ -n "$REFRESH_LINE" ] || fail "npm-global refresh step not found"

RESTART_LINE="$(grep -n "systemctl --user unmask slack-manager.service" "$SCRIPT" | head -n1 | cut -d: -f1)"
[ -n "$RESTART_LINE" ] || fail "could not find the slack-manager restart section"

[ "$REFRESH_LINE" -gt "$BEFORE_LINE" ] || fail "npm-global refresh must run after the build/test steps succeed"
[ "$REFRESH_LINE" -lt "$RESTART_LINE" ] || fail "npm-global refresh must run before slack-manager.service is restarted"

grep -qF 'pnpm run dist:cli' "$SCRIPT" || fail "must rebuild and archive the standalone CLI tarball from the freshly checked-out commit (dist:cli already runs archive-cli-binary.sh)"
grep -qF 'pnpm run dist:slack' "$SCRIPT" || fail "must rebuild and archive the standalone Slack tarball from the freshly checked-out commit (dist:slack already runs archive-slack-binary.sh)"
grep -qF 'bash scripts/archive-cli-binary.sh' "$SCRIPT" && fail "archive-cli-binary.sh must not be invoked directly; pnpm run dist:cli already runs it"
grep -qF 'bash scripts/archive-slack-binary.sh' "$SCRIPT" && fail "archive-slack-binary.sh must not be invoked directly; pnpm run dist:slack already runs it"

grep -qF 'pnpm --filter @neko-catpital-labs/invoker-cli pack' "$SCRIPT" || fail "must build the invoker-cli tarball via pnpm pack (local, not npm publish)"
grep -qF 'pnpm --filter @neko-catpital-labs/invoker-slack pack' "$SCRIPT" || fail "must build the invoker-slack tarball via pnpm pack (local, not npm publish)"
grep -qF 'pnpm --filter @neko-catpital-labs/invoker-ui pack' "$SCRIPT" || fail "must build the invoker-ui tarball via pnpm pack (local, not npm publish)"

grep -qF 'scripts/pin-npm-ui-cli-dependency.mjs' "$SCRIPT" || fail "must pin invoker-ui's invoker-cli dependency to the local tarball, not the real registry"

grep -qF -- '--bind 127.0.0.1' "$SCRIPT" || fail "the local npm asset server must bind to 127.0.0.1 only"

INSTALL_LINES="$(grep -c 'npm install -g "\$' "$SCRIPT" || true)"
[ "$INSTALL_LINES" -eq 3 ] || fail "expected exactly 3 'npm install -g <local tarball>' calls, found $INSTALL_LINES"

grep -qF 'npm install -g "@neko-catpital-labs' "$SCRIPT" && fail "npm install -g must target a local tarball path, not a bare package specifier"

grep -qF "trap 'kill \"\$NPM_ASSET_SERVER_PID\" 2>/dev/null || true' EXIT" "$SCRIPT" \
  || fail "the local asset server must be cleaned up via an EXIT trap so a failed install can't leak it"

echo "PASS: deploy-do1.sh npm-global refresh step is present, ordered correctly, local-only, and self-cleaning"
