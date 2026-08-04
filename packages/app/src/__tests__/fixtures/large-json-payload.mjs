// Shared by write-then-exit-buggy.mjs and write-then-flush-then-exit-fixed.ts:
// a JSON payload comfortably over the ~64KB OS pipe buffer, so a truncated
// write is unambiguous.
export function buildLargePayload() {
  return JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({
    id: `wf-${i}`,
    description: `synthetic workflow row ${i} padded-padded-padded-padded-padded`,
    status: 'completed',
  })));
}
