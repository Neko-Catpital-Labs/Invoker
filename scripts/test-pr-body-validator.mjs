#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePrBody } from './validate-pr-body.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const validMinimal = `## Summary

Small fix.

## Test Plan

- [ ] \`pnpm test\`

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`;

const validArchitecture = `## Summary

Flow change.

## Architecture

### Before

\`\`\`mermaid
graph TD
    A[Before]
\`\`\`

### After

\`\`\`mermaid
graph TD
    B[After]
\`\`\`

## Test Plan

- [ ] \`pnpm test\`

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`;

const lightweight = `## Summary

Small fix.

## Testing

- [ ] \`pnpm test\`

## Notes

None.
`;

assert(validatePrBody(validMinimal).length === 0, 'valid minimal body should pass');
assert(validatePrBody(validArchitecture).length === 0, 'valid architecture body should pass');

const lightweightErrors = validatePrBody(lightweight);
assert(lightweightErrors.some((error) => error.includes('Unsupported section: ## Testing')), 'lightweight format should reject ## Testing');
assert(lightweightErrors.some((error) => error.includes('Unsupported section: ## Notes')), 'lightweight format should reject ## Notes');

const missingTestPlanErrors = validatePrBody(`## Summary

Only summary.

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`);
assert(missingTestPlanErrors.some((error) => error.includes('Missing required section: ## Test Plan')), 'missing test plan should fail');

const malformedArchitectureErrors = validatePrBody(`## Summary

Flow change.

## Architecture

### Before

\`\`\`mermaid
graph TD
    A[Before]
\`\`\`

## Test Plan

- [ ] \`pnpm test\`

## Revert Plan

- Safe to revert? Yes
- Revert command: \`git revert <sha>\`
- Post-revert steps: None
- Data migration? No
`);
assert(malformedArchitectureErrors.some((error) => error.includes('Architecture section is missing required subsection: ### After')), 'missing architecture after section should fail');

const tmp = mkdtempSync(join(tmpdir(), 'invoker-pr-body-'));
try {
  const bodyFile = join(tmp, 'body.md');
  const changedFilesFile = join(tmp, 'changed-files.txt');
  const diffFile = join(tmp, 'pr.diff');
  writeFileSync(bodyFile, validMinimal, 'utf8');
  writeFileSync(changedFilesFile, 'scripts/validate-pr-body.mjs\n', 'utf8');
  writeFileSync(diffFile, '', 'utf8');

  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('validate-pr-body.mjs', import.meta.url)),
      '--body-file',
      bodyFile,
      '--changed-files-file',
      changedFilesFile,
      '--diff-file',
      diffFile,
    ],
    { stdio: 'pipe' },
  );
} finally {
  rmSync(tmp, { force: true, recursive: true });
}

console.log('OK: PR body validator checks passed');
