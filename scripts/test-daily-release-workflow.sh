#!/usr/bin/env bash
# Structural + behavioral checks for daily full release cuts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pass=0
fail=0
assert() {
  local cond="$1"
  local msg="$2"
  if eval "$cond"; then
    pass=$((pass + 1))
  else
    echo "FAIL: $msg" >&2
    fail=$((fail + 1))
  fi
}

# --- Workflow structure ---
assert "grep -q \"uses: ./.github/workflows/reusable-release-build.yml\" .github/workflows/release.yml" \
  "release.yml must call reusable-release-build.yml"
assert "grep -q \"uses: ./.github/workflows/reusable-release-build.yml\" .github/workflows/daily-release.yml" \
  "daily-release.yml must call reusable-release-build.yml"
assert "grep -q \"cron: '0 14 \\* \\* \\*'\" .github/workflows/daily-release.yml" \
  "daily-release.yml must schedule at 14:00 UTC"
assert "grep -q 'prerelease: true' .github/workflows/daily-release.yml" \
  "daily-release.yml must publish as prerelease"
assert "grep -q 'make_latest: false' .github/workflows/daily-release.yml" \
  "daily-release.yml must not mark daily as latest"
assert "! grep -q 'npm publish' .github/workflows/daily-release.yml" \
  "daily-release.yml must not publish npm"
assert "grep -q 'bash scripts/verify-release-assets.sh' .github/workflows/release.yml" \
  "release.yml must use shared verify-release-assets.sh"
assert "grep -q 'bash scripts/verify-release-assets.sh' .github/workflows/daily-release.yml" \
  "daily-release.yml must use shared verify-release-assets.sh"
assert "grep -q 'inputs:' .github/workflows/reusable-release-build.yml && grep -q 'ref:' .github/workflows/reusable-release-build.yml" \
  "reusable-release-build.yml must accept ref input"
assert "grep -q 'cleanup-daily-releases.sh' .github/workflows/daily-release.yml" \
  "daily-release.yml must clean up old daily prereleases"
assert "grep -q 'daily-YYYYMMDD' docs/local-macos-release-build.md" \
  "docs must mention daily-YYYYMMDD prereleases"

# --- verify-release-assets.sh ---
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
version="$(node -p "require('./package.json').version")"
mkdir -p "$tmpdir/release"
required=(
  "invoker-cli-${version}-linux-x64.tar.gz"
  "invoker-cli-${version}-linux-arm64.tar.gz"
  "invoker-cli-${version}-darwin-x64.tar.gz"
  "invoker-cli-${version}-darwin-arm64.tar.gz"
  "invoker-slack-${version}-linux-x64.tar.gz"
  "invoker-slack-${version}-linux-arm64.tar.gz"
  "invoker-slack-${version}-darwin-x64.tar.gz"
  "invoker-slack-${version}-darwin-arm64.tar.gz"
  "Invoker-${version}-x86_64.AppImage"
  "Invoker-${version}-arm64.AppImage"
  "Invoker-${version}-amd64.deb"
  "Invoker-${version}-arm64.deb"
  "Invoker-${version}-x64.dmg"
  "Invoker-${version}-arm64.dmg"
  "Invoker-${version}-x64.zip"
  "Invoker-${version}-arm64.zip"
  "SHA256SUMS"
)
if bash scripts/verify-release-assets.sh "$tmpdir/release" >/dev/null 2>&1; then
  echo "FAIL: verify-release-assets.sh should fail on empty dir" >&2
  fail=$((fail + 1))
else
  pass=$((pass + 1))
fi
for asset in "${required[@]}"; do
  : > "$tmpdir/release/$asset"
done
assert "bash scripts/verify-release-assets.sh \"$tmpdir/release\"" \
  "verify-release-assets.sh should pass with complete asset set"
rm -f "$tmpdir/release/SHA256SUMS"
if bash scripts/verify-release-assets.sh "$tmpdir/release" >/dev/null 2>&1; then
  echo "FAIL: verify-release-assets.sh should fail when SHA256SUMS missing" >&2
  fail=$((fail + 1))
else
  pass=$((pass + 1))
fi

# --- decide + notes in a sandbox repo ---
sandbox="$(mktemp -d)"
git init -q "$sandbox"
git -C "$sandbox" config user.email "daily-release-test@example.com"
git -C "$sandbox" config user.name "Daily Release Test"
echo base > "$sandbox/README"
# package.json needed by notes script
printf '{"version":"%s"}\n' "$version" > "$sandbox/package.json"
git -C "$sandbox" add README package.json
git -C "$sandbox" commit -q -m "base"
git -C "$sandbox" branch -M master
mkdir -p "$sandbox/scripts"
cp scripts/daily-release-decide.sh scripts/generate-daily-release-notes.sh "$sandbox/scripts/"
chmod +x "$sandbox/scripts/"*.sh

# First cut on a date with no prior daily tags should run
out1="$sandbox/out1.env"
bash "$sandbox/scripts/daily-release-decide.sh" --tip master --date 20260728 --out "$out1" >"$sandbox/decide1.txt"
assert "grep -qx 'tag=daily-20260728' \"$out1\"" "decide should emit today's tag"
assert "grep -qx 'should_run=true' \"$out1\"" "decide should run when no prior daily tag"
sha="$(git -C "$sandbox" rev-parse master)"
assert "grep -qx \"sha=${sha}\" \"$out1\"" "decide should emit tip sha"

# Tag that cut, then re-decide same day => skip
git -C "$sandbox" tag "daily-20260728" "$sha"
out2="$sandbox/out2.env"
bash "$sandbox/scripts/daily-release-decide.sh" --tip master --date 20260728 --out "$out2" >"$sandbox/decide2.txt"
assert "grep -qx 'should_run=false' \"$out2\"" "same-day re-run must skip"
assert "grep -q 'already exists' \"$out2\"" "skip reason should mention existing tag"

# New commit but same tip as previous daily on a later day with no new commits after tagging:
# add a commit, tag previous day on old sha, tip moves => should run
echo change > "$sandbox/README"
git -C "$sandbox" add README
git -C "$sandbox" commit -q -m "change"
new_sha="$(git -C "$sandbox" rev-parse master)"
out3="$sandbox/out3.env"
bash "$sandbox/scripts/daily-release-decide.sh" --tip master --date 20260729 --out "$out3" >"$sandbox/decide3.txt"
assert "grep -qx 'should_run=true' \"$out3\"" "decide should run when tip advanced"
assert "grep -qx 'previous_tag=daily-20260728' \"$out3\"" "decide should see previous daily tag"
assert "grep -qx \"sha=${new_sha}\" \"$out3\"" "decide should emit new tip sha"

# Tip equal to previous daily tag commit => skip
git -C "$sandbox" tag "daily-20260729" "$new_sha"
# Simulate next day with no new commits
out4="$sandbox/out4.env"
bash "$sandbox/scripts/daily-release-decide.sh" --tip master --date 20260730 --out "$out4" >"$sandbox/decide4.txt"
assert "grep -qx 'should_run=false' \"$out4\"" "decide must skip when no new commits since previous daily"
assert "grep -q 'no new commits' \"$out4\"" "skip reason should mention no new commits"

# Notes generation
notes="$sandbox/RELEASE_NOTES.md"
bash "$sandbox/scripts/generate-daily-release-notes.sh" \
  --tag daily-20260729 \
  --sha "$new_sha" \
  --previous-tag daily-20260728 \
  --out "$notes"
assert "grep -q 'daily cut 2026-07-29' \"$notes\"" "notes should include pretty date"
assert "grep -q 'Prerelease' \"$notes\"" "notes should say prerelease"
assert "grep -q 'install.sh --version daily-20260729' \"$notes\"" "notes should mention install by tag"
assert "grep -q 'Commits since daily-20260728' \"$notes\"" "notes should include commit range heading"
assert "grep -q 'change' \"$notes\"" "notes should include commit subject"

# cleanup dry-run shape (no network delete)
if command -v gh >/dev/null 2>&1; then
  # Only validates arg parsing / cutoff computation path with dry-run against unreachable repo is ok to skip.
  # Exercise --help / invalid args instead.
  if bash scripts/cleanup-daily-releases.sh --help >/dev/null; then
    pass=$((pass + 1))
  else
    echo "FAIL: cleanup-daily-releases.sh --help" >&2
    fail=$((fail + 1))
  fi
else
  pass=$((pass + 1))
fi

# Stable latest path still uses GitHub /releases/latest (not prereleases)
assert "grep -q 'api_url=\"\$api_url/latest\"' scripts/install.sh" \
  "install.sh latest path must remain /releases/latest (ignores prereleases)"

echo "daily-release checks: ${pass} passed, ${fail} failed"
exit "$fail"
