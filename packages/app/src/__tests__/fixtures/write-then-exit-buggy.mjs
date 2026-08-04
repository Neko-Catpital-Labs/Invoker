// The historical bug at packages/app/src/main.ts (pre-fix): write to a piped
// stdout, then exit immediately without waiting for the write to flush.
// Used as the "before" half of the regression test in ../headless-stdio-flush.test.ts.
import { buildLargePayload } from './large-json-payload.mjs';

const payload = buildLargePayload();
process.stderr.write(JSON.stringify({ expectedLength: payload.length }));
process.stdout.write(payload);
process.exit(0);
