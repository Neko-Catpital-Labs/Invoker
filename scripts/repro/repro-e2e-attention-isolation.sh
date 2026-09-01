#!/usr/bin/env bash
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"
echo "Run the ordinary Playwright attention observer and inspect its zero-transition result."
