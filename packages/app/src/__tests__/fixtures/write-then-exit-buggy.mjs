// The historical bug at packages/app/src/main.ts (pre-fix): write to a piped
// stdout, then exit immediately without waiting for the write to flush.
// Used as the "before" half of the regression test in ../headless-stdio-flush.test.ts.
import { buildLargePayload } from './large-json-payload.mjs';

const payload = buildLargePayload();
process.stderr.write(JSON.stringify({ expectedLength: payload.length }));
// Keep this repro deterministic across Node/libuv versions: force the payload
// to remain buffered, then exit with the same pre-fix write-then-exit pattern.
process.stdout.cork();
process.stdout.write(payload);
process.exit(0);
