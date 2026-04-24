#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const REQUIRED_SECTIONS = ['## Summary', '## Test Plan', '## Revert Plan'];
const DISCOURAGED_HEADINGS = ['## Testing', '## Notes'];

export function validatePrBody(body) {
  const errors = [];
  const trimmed = body.trim();

  if (!trimmed) {
    return [
      'PR body is empty. Use the canonical schema: ## Summary, ## Test Plan, ## Revert Plan, plus optional ## Architecture.',
    ];
  }

  for (const heading of REQUIRED_SECTIONS) {
    if (!trimmed.includes(heading)) {
      errors.push(`Missing required section: ${heading}`);
    }
  }

  for (const heading of DISCOURAGED_HEADINGS) {
    if (trimmed.includes(heading)) {
      errors.push(
        `Unsupported section: ${heading}. Do not use the lightweight PR format; use ## Test Plan and ## Revert Plan instead.`,
      );
    }
  }

  if (trimmed.includes('## Architecture')) {
    for (const subsection of ['### Before', '### After']) {
      if (!trimmed.includes(subsection)) {
        errors.push(`Architecture section is missing required subsection: ${subsection}`);
      }
    }
  }

  return errors;
}

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
