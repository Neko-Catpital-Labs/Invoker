import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldWrapInDevelopmentProfile } = require('./electron-development-profile-guard.cjs');

// Regression: the production owner on a source-checkout host (no packaged
// invoker-ui on PATH) launches via `electron.cjs ... --headless owner-serve`
// with no INVOKER_DEVELOPMENT_PROFILE_ACTIVE set. Before this fix that always
// redirected the real production owner into an isolated dev-profile sandbox
// database (confirmed live on DigitalOcean 1: production invoker.db stopped
// being written while a fresh ~/.invoker/dev/<hash>/ sandbox was actively
// written instead). packages/slack-manager/src/invoker-launcher.ts now sets
// INVOKER_PRODUCTION_OWNER_SERVICE=1 on that exact spawn.
assert.equal(
  shouldWrapInDevelopmentProfile('--no-sandbox', { INVOKER_PRODUCTION_OWNER_SERVICE: '1' }),
  false,
  'the real production owner spawn must not be wrapped into a dev profile',
);

assert.equal(
  shouldWrapInDevelopmentProfile('--no-sandbox', {}),
  true,
  'an ordinary developer launch (no production flag) must still get an isolated dev profile',
);

assert.equal(
  shouldWrapInDevelopmentProfile('--install-only', {}),
  false,
  'the postinstall electron-download step must never wrap',
);

assert.equal(
  shouldWrapInDevelopmentProfile('--no-sandbox', { INVOKER_DEVELOPMENT_PROFILE_ACTIVE: '1' }),
  false,
  'a re-exec that already carries the active-profile marker must not wrap again',
);

console.log('PASS: electron.cjs only wraps launches that are not the declared production owner service');
