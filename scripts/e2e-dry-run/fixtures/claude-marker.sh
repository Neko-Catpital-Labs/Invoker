#!/usr/bin/env bash
# Dummy Claude CLI for e2e-dry-run: no network, instant exit 0.
# Invoked like: claude --session-id <uuid> ... (prompt) or via INVOKER_CLAUDE_FIX_COMMAND (fix).
set -eu
ALL_ARGS="$*"
SESSION_ID=""
RESUME_ID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-id)
      if [ "$#" -lt 2 ]; then
        echo "claude-marker: --session-id requires a value" >&2
        exit 2
      fi
      SESSION_ID="$2"
      shift 2
      ;;
    --resume)
      if [ "$#" -lt 2 ]; then
        echo "claude-marker: --resume requires a value" >&2
        exit 2
      fi
      RESUME_ID="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [ -n "$RESUME_ID" ]; then
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    echo "stdin is not a terminal" >&2
    exit 12
  fi
  sleep 1
  echo "TTY OK: claude resume $RESUME_ID"
  exit 0
fi

ROOT="${INVOKER_E2E_MARKER_ROOT:-}"
if [ -n "$ROOT" ] && [ -n "$SESSION_ID" ]; then
  mkdir -p "$ROOT"
  # Portable timestamp (no %N on macOS bash)
  ts="$(date +%s)"
  echo ok >"$ROOT/${SESSION_ID}-${ts}-$$.marker"
fi

if printf '%s' "$ALL_ARGS" | grep -Fq 'Publish the Invoker-on-Invoker review PR stack'; then
  if command -v gh >/dev/null 2>&1; then
    gh api repos/Neko-Catpital-Labs/Invoker/pulls --method GET -f state=open -f head=Neko-Catpital-Labs:e2e-review-stack -f per_page=1 >/dev/null 2>&1 || true
    gh api repos/Neko-Catpital-Labs/Invoker/pulls --method POST -f base=master -f head=e2e-review-stack -f title='E2E review stack' -f body='E2E review body' >/dev/null 2>&1 || true
  fi
  node <<'NODE'
const body = [
  '## Summary',
  '',
  'E2E review stack publication for the dry-run workflow.',
  '',
  '## Review Claim',
  '',
  'This proof-only change validates the review gate publication path.',
  '',
  '## Review Lane',
  '',
  'proof',
  '',
  '## Review Unit',
  '',
  'proof',
  '',
  '## Safety Invariant',
  '',
  'Only e2e fixture output is affected; production behavior is unchanged.',
  '',
  '## Slice Rationale',
  '',
  'The dry-run fixture must publish the single review artifact expected by the gate.',
  '',
  '## Non-goals',
  '',
  'No production behavior change.',
  '',
  '## Test Plan',
  '',
  '<details>',
  '<summary>Test Plan</summary>',
  '',
  '- [x] e2e dry-run review stack fixture',
  '',
  '</details>',
  '',
  '## Revert Plan',
  '',
  '<details>',
  '<summary>Revert Plan</summary>',
  '',
  '- Safe to revert? Yes',
  '- Revert command: `git revert <sha>`',
  '- Post-revert steps: None',
  '- Data migration? No',
  '',
  '</details>',
].join('\n');
const artifact = {
  id: 'e2e-review-stack',
  title: 'E2E review stack',
  url: 'https://github.com/test/repo/pull/99',
  providerId: '99',
  branch: 'e2e-review-stack',
  baseBranch: 'master',
  dependsOn: [],
  body,
};
process.stdout.write(JSON.stringify({ artifacts: [artifact] }));
NODE
  exit 0
fi

# Auto-resolve merge conflicts (no-op when none exist).
if git rev-parse --git-dir >/dev/null 2>&1; then
  UNMERGED=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
  if [ -n "$UNMERGED" ]; then
    git checkout --theirs . 2>/dev/null || true
    git add -A 2>/dev/null || true
    git -c user.name='e2e-stub' -c user.email='stub@test' \
      commit --no-edit 2>/dev/null || true
  fi
fi

exit 0
