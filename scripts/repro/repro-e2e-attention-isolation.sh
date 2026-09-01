#!/usr/bin/env bash
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

echo "Run the repository's terminal attention observer for the ordinary Playwright spec, then inspect its zero-transition result."
exit 0
