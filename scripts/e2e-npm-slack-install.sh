#!/usr/bin/env bash
# E2E: prove that `npm install` of @neko-catpital-labs/invoker-slack yields a
# working `invoker-slack` command, using a locally built release artifact served
# over localhost instead of a GitHub release (postinstall honors
# INVOKER_RELEASE_BASE_URL).
#
# Usage: bash scripts/e2e-npm-slack-install.sh
#   INVOKER_E2E_SKIP_BUILD=1   reuse existing release/ artifacts
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./packages/npm-slack/package.json').version")"
PLATFORM="$(node -p "process.platform")"
ARCH="$(node -p "process.arch")"
SLACK_TARBALL="release/invoker-slack-$VERSION-$PLATFORM-$ARCH.tar.gz"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-npm-slack.XXXXXX")"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

if [ "${INVOKER_E2E_SKIP_BUILD:-0}" != "1" ]; then
  pnpm run dist:slack
fi
if [ ! -f "$SLACK_TARBALL" ]; then
  echo "Missing $SLACK_TARBALL — run without INVOKER_E2E_SKIP_BUILD=1 to build it." >&2
  exit 1
fi
bash scripts/release-sha256.sh

PORT="${INVOKER_E2E_PORT:-8764}"
python3 -m http.server "$PORT" --directory release --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PORT/SHA256SUMS" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS "http://127.0.0.1:$PORT/SHA256SUMS" >/dev/null

PACK_DIR="$SCRATCH/tarballs"
mkdir -p "$PACK_DIR"
pnpm --filter @neko-catpital-labs/invoker-slack pack --pack-destination "$PACK_DIR" >/dev/null
SLACK_TGZ="$(ls "$PACK_DIR"/*invoker-slack*.tgz)"

PROJECT_DIR="$SCRATCH/project"
mkdir -p "$PROJECT_DIR"
(
  cd "$PROJECT_DIR"
  INVOKER_RELEASE_BASE_URL="http://127.0.0.1:$PORT" \
    npm install --no-fund --no-audit "$SLACK_TGZ"
)

fail() { echo "FAIL: $1" >&2; exit 1; }

ACTUAL_VERSION="$("$PROJECT_DIR/node_modules/.bin/invoker-slack" --version)"
[ "$ACTUAL_VERSION" = "$VERSION" ] \
  || fail "node_modules/.bin/invoker-slack --version printed '$ACTUAL_VERSION', expected '$VERSION'"

[ -x "$PROJECT_DIR/node_modules/@neko-catpital-labs/invoker-slack/vendor/invoker-slack" ] \
  || fail "invoker-slack postinstall did not install vendor binary"

# The plan-doctor scripts ship inside this real npm install's own
# vendor/skills/ (scripts/archive-slack-binary.sh's payload) with no
# monorepo, no INVOKER_REPO_ROOT, and no ~/.invoker/bundled-skills.json
# anywhere near it — the exact shape a cut invoker-slack binary has for
# anyone who `npm install -g`'d it. Prove the doctor actually runs there,
# not just that the binary and its vendor files exist.
SLACK_INSTALL_ROOT="$PROJECT_DIR/node_modules/@neko-catpital-labs/invoker-slack"
SLACK_DOCTOR="$SLACK_INSTALL_ROOT/vendor/skills/plan-to-invoker/scripts/skill-doctor.sh"
[ -f "$SLACK_DOCTOR" ] || fail "npm install did not lay down $SLACK_DOCTOR"
# Isolate HOME and INVOKER_DB_DIR under $SCRATCH: an inherited real
# ~/.invoker/bundled-skills.json would let the doctor's manifest fallback
# resolve yaml/scripts via the tester's own monorepo checkout, masking a
# missing packaged dependency instead of proving the npm install stands alone.
DOCTOR_HOME="$SCRATCH/doctor-home"
mkdir -p "$DOCTOR_HOME"
DOCTOR_OUTPUT="$(cd "$SCRATCH" && env -u INVOKER_REPO_ROOT HOME="$DOCTOR_HOME" INVOKER_DB_DIR="$DOCTOR_HOME/.invoker" bash "$SLACK_DOCTOR" --skip-assumptions "$ROOT/skills/plan-to-invoker/fixtures/positive/02-feature-implementation.yaml" 2>/dev/null || true)"
for step in validate-plan lint-review-units; do
  STATUS="$(printf '%s' "$DOCTOR_OUTPUT" | node -e '
    const raw = require("node:fs").readFileSync(0, "utf8");
    const report = JSON.parse(raw);
    const check = report.checks.find((c) => c.stepId === process.argv[1]);
    process.stdout.write(check ? String(check.status) : "missing");
  ' "$step")"
  [ "$STATUS" = "passed" ] || fail "real npm-installed invoker-slack doctor step $step did not pass; got status=$STATUS. Full output: $DOCTOR_OUTPUT"
done

echo "ok npm install yields working invoker-slack $VERSION with a working plan-doctor (validate-plan + lint-review-units)"
