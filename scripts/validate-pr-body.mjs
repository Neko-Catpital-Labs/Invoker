#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { validateCanonicalPrBody as validatePrBody } from '../packages/execution-engine/src/canonical-pr-body.js';

export { validatePrBody };

function usage() {
  console.error(`Usage: node scripts/validate-pr-body.mjs (--body-file <file> | --body <markdown>)

Validates the canonical PR schema:
  Required: ## Summary, ## Test Plan, ## Revert Plan
  Optional: ## Architecture (must include ### Before and ### After when present)`);
  process.exit(1);
}

function parseArgs(argv) {
  let body = '';
  let bodyFile = '';

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--body':
        body = argv[++i] || '';
        break;
      case '--body-file':
        bodyFile = argv[++i] || '';
        break;
      case '--help':
        usage();
        break;
      default:
        console.error(`Unknown option: ${argv[i]}`);
        usage();
    }
  }

  if (Boolean(body) === Boolean(bodyFile)) {
    console.error('Pass exactly one of --body or --body-file.');
    usage();
  }

  return { body, bodyFile };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const body = args.bodyFile ? readFileSync(args.bodyFile, 'utf-8') : args.body;
  const errors = validatePrBody(body);

  if (errors.length > 0) {
    console.error('PR body validation failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log('PR body validation passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
