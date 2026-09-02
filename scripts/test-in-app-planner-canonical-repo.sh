#!/usr/bin/env bash
set -u

pnpm --filter @invoker/app test -- src/__tests__/in-app-planner.test.ts
status=$?
printf 'FOCUSED_TEST_EXIT_CODE=%s\n' "$status"
exit "$status"
