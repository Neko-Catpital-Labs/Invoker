#!/usr/bin/env bash
# Vendors the plan-doctor's two out-of-tree dependencies into
# skills/plan-to-invoker/scripts/vendor/, so skill-doctor.sh (and its
# validate-plan/lint-review-units sub-checks) work from ANY copy of the
# skills/ directory alone -- including a distributed invoker-cli / invoker-slack
# release tarball (scripts/archive-cli-binary.sh, scripts/archive-slack-binary.sh),
# which ship skills/ with no packages/, no node_modules, and no repo-root
# scripts/ directory alongside it.
#
# Vendored:
#   - the `yaml` npm package (pure JS, no runtime deps, ISC license) --
#     source of truth is packages/app/node_modules/yaml.
#   - scripts/review-unit-rules.mjs -- source of truth is this repo's own
#     scripts/review-unit-rules.mjs, shared by several other repo-root
#     scripts (validate-pr-body.mjs, check-pr-body-keywords.mjs, etc.), so
#     it stays canonical at that path and is copied, not moved.
#
# Run this whenever the `yaml` dependency is upgraded or
# scripts/review-unit-rules.mjs changes. scripts/test-plan-to-invoker-skill.sh
# fails CI if the vendored copies drift from their sources.
#
# Usage: bash scripts/vendor-plan-doctor-deps.sh
set -euo pipefail
cd "$(dirname "$0")/.."

YAML_SOURCE="packages/app/node_modules/yaml"
VENDOR_DIR="skills/plan-to-invoker/scripts/vendor"

if [ ! -d "$YAML_SOURCE/browser" ]; then
  echo "FAIL: no $YAML_SOURCE/browser found. Run pnpm install first." >&2
  exit 1
fi

YAML_VERSION="$(node -p "require('./$YAML_SOURCE/package.json').version")"

rm -rf "$VENDOR_DIR/yaml"
mkdir -p "$VENDOR_DIR/yaml"
cp -R "$YAML_SOURCE/browser/." "$VENDOR_DIR/yaml/"
cp "$YAML_SOURCE/LICENSE" "$VENDOR_DIR/yaml/LICENSE"

# The repo's root .gitignore excludes any directory named `dist/` (build
# output), which would silently swallow this vendored copy's `dist/` folder
# on every commit. Rename it and fix the one file that references it by
# that name -- internal imports within the folder are all sibling-relative
# and don't care what the folder itself is called.
mv "$VENDOR_DIR/yaml/dist" "$VENDOR_DIR/yaml/lib"
sed -i.bak "s#\./dist/index\.js#./lib/index.js#g" "$VENDOR_DIR/yaml/index.js"
rm -f "$VENDOR_DIR/yaml/index.js.bak"

cat > "$VENDOR_DIR/yaml/.vendor-source.json" <<JSON
{
  "source": "yaml",
  "sourceRegistry": "https://www.npmjs.com/package/yaml",
  "sourceVersion": "$YAML_VERSION",
  "sourceLocalPath": "$YAML_SOURCE/browser",
  "vendoredAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

cp scripts/review-unit-rules.mjs "$VENDOR_DIR/review-unit-rules.mjs"

echo "Vendored yaml@$YAML_VERSION and review-unit-rules.mjs into $VENDOR_DIR/"
