#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const REQUIRED_SECTIONS = ['## Summary', '## Test Plan', '## Revert Plan'];
const DISCOURAGED_HEADINGS = ['## Testing', '## Notes'];
const SUMMARY_WORD_LIMIT = 30;

function getSectionBody(body, heading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return '';

  const sectionLines = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    sectionLines.push(line);
  }

  return sectionLines.join('\n').trim();
}

function countWords(text) {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function hasVisualProofMedia(body) {
  const visualProof = getSectionBody(body, '## Visual Proof');
  if (!visualProof) return false;

  return /!\[[^\]]*\]\([^)]+\)/.test(visualProof)
    || /\[[^\]]*(?:video|walkthrough|recording)[^\]]*\]\([^)]+\)/i.test(visualProof)
    || /\bhttps?:\/\/\S+\.(?:png|jpe?g|gif|webp|webm|mp4)\b/i.test(visualProof);
}


export function getPrBodyWarnings(body) {
  const warnings = [];
  const summary = getSectionBody(body, '## Summary');
  if (!summary) return warnings;

  const paragraphs = summary.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  paragraphs.forEach((paragraph, index) => {
    const wordCount = countWords(paragraph);
    if (wordCount > SUMMARY_WORD_LIMIT) {
      warnings.push(
        `Summary paragraph ${index + 1} is ${wordCount} words. Keep each Summary paragraph under ${SUMMARY_WORD_LIMIT} words.`,
      );
    }
  });

  return warnings;
}

export function validatePrBody(body, options = {}) {
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


  if (options.requiresVisualProof && !hasVisualProofMedia(trimmed)) {
    errors.push(
      'UI-impacting changes require a ## Visual Proof section with at least one screenshot image or video/walkthrough link.',
    );
  }
  return errors;
}

function usage() {
  console.error(`Usage: node scripts/validate-pr-body.mjs (--body-file <file> | --body <markdown>) [--require-visual-proof]

Validates the canonical PR schema:
  Required: ## Summary, ## Test Plan, ## Revert Plan
  Optional: ## Architecture (must include ### Before and ### After when present)
  UI changes: pass --require-visual-proof to require screenshot or video proof.`);
  process.exit(1);
}

function parseArgs(argv) {
  let body = '';
  let bodyFile = '';
  let requiresVisualProof = false;
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--body':
        body = argv[++i] || '';
        break;
      case '--body-file':
        bodyFile = argv[++i] || '';
        break;
      case '--require-visual-proof':
        requiresVisualProof = true;
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

  return { body, bodyFile, requiresVisualProof };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const body = args.bodyFile ? readFileSync(args.bodyFile, 'utf-8') : args.body;
  const errors = validatePrBody(body, { requiresVisualProof: args.requiresVisualProof });
  const warnings = getPrBodyWarnings(body);

  if (errors.length > 0) {
    console.error('PR body validation failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.error('PR body validation warnings:');
    for (const warning of warnings) {
      console.error(`- ${warning}`);
    }
  }

  console.log('PR body validation passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
