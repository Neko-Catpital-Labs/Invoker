#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import {
  getMarkdownSection,
  validateSingleReviewUnitFocus,
} from './review-unit-rules.mjs';

const REQUIRED_SECTIONS = [
  '## Summary',
  '## Review Claim',
  '## Review Lane',
  '## Safety Invariant',
  '## Slice Rationale',
  '## Non-goals',
  '## Test Plan',
  '## Revert Plan',
];
const DISCOURAGED_HEADINGS = ['## Testing', '## Notes'];
const SUMMARY_WORD_LIMIT = 30;
const VALID_REVIEW_LANES = new Set(['behavior', 'refactor', 'proof', 'cleanup', 'policy', 'docs']);

function getSectionBody(body, heading) {
  return getMarkdownSection(body, heading);
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

function normalizeSectionValue(sectionBody) {
  const firstLine = sectionBody
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) return '';
  return firstLine.replace(/^[-*]\s*/, '').trim().toLowerCase();
}

function classifyScopeKind(filePath) {
  const path = filePath.replace(/\\/g, '/');

  if (path.startsWith('scripts/repro/')) return 'proof';
  if (path.startsWith('skills/') || path.startsWith('docs/') || path.endsWith('.md')) return 'docs';
  if (path.startsWith('scripts/')) return 'policy';
  if (
    path.includes('/e2e/')
    || path.includes('/__tests__/')
    || /\.(spec|test)\.[jt]sx?$/.test(path)
  ) {
    if (/(benchmark|performance|visual-proof)/.test(path)) return 'proof';
    return 'product-test';
  }
  if (/(benchmark|performance|visual-proof)/.test(path)) return 'proof';
  if (path.startsWith('packages/')) return 'product';
  return 'other';
}

function formatKinds(kinds) {
  return Array.from(kinds).sort().join(', ');
}

export function validatePrScope({ changedFiles = [], reviewLane = '', body = '' } = {}) {
  const errors = [];
  if (!reviewLane || changedFiles.length === 0) return errors;

  const kinds = new Set(changedFiles.map(classifyScopeKind).filter((kind) => kind !== 'other'));
  const nonGoals = getSectionBody(body, '## Non-goals').toLowerCase();

  if (reviewLane === 'behavior' || reviewLane === 'refactor' || reviewLane === 'cleanup') {
    const forbidden = ['docs', 'policy', 'proof'].filter((kind) => kinds.has(kind));
    if (forbidden.length > 0) {
      errors.push(
        `Review lane ${reviewLane} cannot ship with ${forbidden.join(', ')} files in the same PR. Split behavior or cleanup from docs, policy, repro, and benchmark slices.`,
      );
    }
  }

  if (reviewLane === 'proof') {
    const forbidden = ['product', 'docs', 'policy'].filter((kind) => kinds.has(kind));
    if (forbidden.length > 0) {
      errors.push(
        `Review lane proof cannot ship with ${forbidden.join(', ')} files in the same PR. Keep benchmarks, repros, and regression proof separate from behavior or policy changes.`,
      );
    }
  }

  if (reviewLane === 'policy') {
    const forbidden = ['product', 'proof'].filter((kind) => kinds.has(kind));
    if (forbidden.length > 0) {
      errors.push(
        `Review lane policy cannot ship with ${forbidden.join(', ')} files in the same PR. Keep tooling/runtime policy separate from behavior and proof changes.`,
      );
    }
  }

  if (reviewLane === 'docs') {
    const forbidden = ['product', 'policy', 'proof', 'product-test'].filter((kind) => kinds.has(kind));
    if (forbidden.length > 0) {
      errors.push(
        `Review lane docs cannot ship with ${forbidden.join(', ')} files in the same PR. Keep docs and skill updates in their own slice.`,
      );
    }
  }

  if (reviewLane === 'refactor') {
    if (!/(no behavior change|behavior unchanged|unchanged behavior|pass unchanged)/.test(nonGoals)) {
      errors.push('Review lane refactor must state in ## Non-goals that behavior stays unchanged.');
    }
  }

  return errors;
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
      'PR body is empty. Use the canonical schema: ## Summary, ## Review Claim, ## Review Lane, ## Safety Invariant, ## Slice Rationale, ## Non-goals, ## Test Plan, and ## Revert Plan.',
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
        `Unsupported section: ${heading}. Do not use the lightweight PR format; use the canonical review-compression schema instead.`,
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

  const reviewLane = normalizeSectionValue(getSectionBody(trimmed, '## Review Lane'));
  if (reviewLane && !VALID_REVIEW_LANES.has(reviewLane)) {
    errors.push(`Invalid review lane: ${reviewLane}. Expected one of ${Array.from(VALID_REVIEW_LANES).join(', ')}.`);
  }

  const reviewClaim = getSectionBody(trimmed, '## Review Claim');
  if (reviewClaim && !reviewClaim.trim()) {
    errors.push('## Review Claim must not be empty.');
  }
  errors.push(...validateSingleReviewUnitFocus({
    context: 'PR body',
    texts: [
      getSectionBody(trimmed, '## Summary'),
      reviewClaim,
      getSectionBody(trimmed, '## Slice Rationale'),
    ],
  }));

  if (options.requiresVisualProof && !hasVisualProofMedia(trimmed)) {
    errors.push(
      'UI-impacting changes require a ## Visual Proof section with at least one screenshot image or video/walkthrough link.',
    );
  }

  if (reviewLane && options.changedFiles?.length) {
    errors.push(...validatePrScope({ changedFiles: options.changedFiles, reviewLane, body: trimmed }));
  }

  return errors;
}

function usage() {
  console.error(`Usage: node scripts/validate-pr-body.mjs (--body-file <file> | --body <markdown>) [--require-visual-proof]

Validates the canonical PR schema:
  Required: ## Summary, ## Review Claim, ## Review Lane, ## Safety Invariant, ## Slice Rationale, ## Non-goals, ## Test Plan, ## Revert Plan
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
