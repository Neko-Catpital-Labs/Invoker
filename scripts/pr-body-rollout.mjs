#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ENABLE_ALL_VALUES = new Set(['1', 'true', 'yes', 'y', 'on', 'all', 'everyone']);

export function parseBooleanSwitch(value) {
  return ENABLE_ALL_VALUES.has(String(value ?? '').trim().toLowerCase());
}

export function parseAuthorList(value) {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((author) => author.trim().toLowerCase())
    .filter(Boolean);
}

export function shouldEnforcePrBody({ author, enforceAll, enforcedAuthors }) {
  const normalizedAuthor = String(author ?? '').trim().toLowerCase();
  if (!normalizedAuthor) return false;
  if (parseBooleanSwitch(enforceAll)) return true;
  return parseAuthorList(enforcedAuthors).includes(normalizedAuthor);
}

function parseArgs(argv) {
  const args = {
    author: process.env.PR_BODY_AUTHOR ?? '',
    enforceAll: process.env.PR_BODY_ENFORCE_ALL ?? '',
    enforcedAuthors: process.env.PR_BODY_ENFORCED_AUTHORS ?? '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--author':
        args.author = argv[++i] ?? '';
        break;
      case '--enforce-all':
        args.enforceAll = argv[++i] ?? '';
        break;
      case '--authors':
        args.enforcedAuthors = argv[++i] ?? '';
        break;
      default:
        throw new Error(`Unknown option: ${argv[i]}`);
    }
  }

  return args;
}

function writeGitHubOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export function evaluateRollout(args) {
  const enabled = shouldEnforcePrBody(args);
  return {
    enabled,
    author: String(args.author ?? '').trim(),
    enforceAll: parseBooleanSwitch(args.enforceAll),
    enforcedAuthors: parseAuthorList(args.enforcedAuthors),
  };
}

async function main() {
  const result = evaluateRollout(parseArgs(process.argv.slice(2)));
  writeGitHubOutput('enabled', result.enabled ? 'true' : 'false');
  writeGitHubOutput('author', result.author);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
