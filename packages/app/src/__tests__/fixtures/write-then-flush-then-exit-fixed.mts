// Uses the real, shared flushOutputStream helper that both
// packages/app/src/main.ts and packages/app/src/headless-client.ts rely on to
// avoid truncating a piped stdout write before process.exit().
// Used as the "after" half of the regression test in ../headless-stdio-flush.test.ts.
import { flushOutputStream } from '../../headless-stdio.ts';
import { buildLargePayload } from './large-json-payload.mjs';

async function main(): Promise<void> {
  const payload = buildLargePayload();
  process.stderr.write(JSON.stringify({ expectedLength: payload.length }));
  process.stdout.write(payload);
  await flushOutputStream(process.stdout);
  process.exit(0);
}

main();
