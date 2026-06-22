#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import {
  formatReviewUnits,
  getLabelSection,
  getMarkdownSection,
  normalizeReviewUnit,
  reviewUnitsForChangedFiles,
  validateReviewLaneUnitCompatibility,
  validateReviewUnitChangedFiles,
  validateReviewUnitFocus,
  validateReviewUnitValue,
} from './review-unit-rules.mjs';

const REQUIRED_SECTIONS = [
  '## Summary',
  '## Non-goals',
  '## Test Plan',
  '## Revert Plan',
];
const VISIBLE_METADATA_SECTIONS = [
  '## Review Claim',
  '## Review Lane',
  '## Review Unit',
  '## Safety Invariant',
  '## Slice Rationale',
];
const REQUIRED_METADATA_LABELS = [
  'Review Claim',
  'Review Lane',
  'Review Unit',
  'Safety Invariant',
  'Slice Rationale',
];
const DISCOURAGED_HEADINGS = ['## Testing', '## Notes'];
const SUMMARY_WORD_LIMIT = 30;
const VALID_REVIEW_LANES = new Set(['behavior', 'refactor', 'proof', 'cleanup', 'policy', 'docs']);

const MERMAID_BLOCK_PATTERN = /```mermaid[^\n]*\n([\s\S]*?)```/gi;
const MERMAID_LABEL_QUOTE_GUIDANCE = 'Quote Mermaid labels that contain prose or code-ish text, for example A["reviewGate.artifacts[] is pending"].';

let mermaidApiPromise;
let mermaidRenderCounter = 0;

function extractMermaidBlocks(body) {
  const blocks = [];
  let match;
  let index = 0;

  while ((match = MERMAID_BLOCK_PATTERN.exec(body)) !== null) {
    index += 1;
    blocks.push({ index, source: match[1].trim() });
  }

  return blocks;
}

function summarizeMermaidError(error) {
  return String(error?.message ?? error)
    .replace(/\s+/g, ' ')
    .trim();
}

async function getMermaidApi() {
  if (!mermaidApiPromise) {
    mermaidApiPromise = (async () => {
      const { window } = new JSDOM('<body></body>', { pretendToBeVisual: true });
      globalThis.window = window;
      globalThis.document = window.document;
      globalThis.Element = window.Element;
      globalThis.HTMLElement = window.HTMLElement;
      globalThis.SVGElement = window.SVGElement;
      globalThis.Node = window.Node;
      globalThis.DOMParser = window.DOMParser;
      globalThis.XMLSerializer = window.XMLSerializer;
      globalThis.getComputedStyle = window.getComputedStyle;
      globalThis.CSSStyleSheet = window.CSSStyleSheet;

      if (!window.SVGElement.prototype.getBBox) {
        window.SVGElement.prototype.getBBox = function getBBox() {
          const text = this.textContent || '';
          return { x: 0, y: 0, width: Math.max(10, text.length * 8), height: 16 };
        };
      }
      if (!window.SVGElement.prototype.getComputedTextLength) {
        window.SVGElement.prototype.getComputedTextLength = function getComputedTextLength() {
          const text = this.textContent || '';
          return Math.max(10, text.length * 8);
        };
      }

      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
      return mermaid;
    })();
  }

  return mermaidApiPromise;
}

export async function validateMermaidBlocks(body, options = {}) {
  const context = options.context ?? 'PR body';
  const mermaidBlocks = extractMermaidBlocks(body);
  if (mermaidBlocks.length === 0) return [];

  const mermaid = await getMermaidApi();
  const errors = [];

  for (const block of mermaidBlocks) {
    try {
      await mermaid.parse(block.source);
      mermaidRenderCounter += 1;
      await mermaid.render(`pr-body-mermaid-${mermaidRenderCounter}`, block.source);
    } catch (error) {
      errors.push(
        `${context} Mermaid block ${block.index} is invalid: ${summarizeMermaidError(error)} ${MERMAID_LABEL_QUOTE_GUIDANCE}`,
      );
    }
  }

  return errors;
}

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
  return normalizeReviewUnit(sectionBody);
}

function getReviewMetadataBlock(body) {
  const summary = getSectionBody(body, '## Summary');
  const match = summary.match(/<details\b([^>]*)>\s*<summary>\s*Review metadata\s*<\/summary>([\s\S]*?)<\/details>/i);
  if (!match) return { body: '', openAttributes: '' };
  return { body: match[2].trim(), openAttributes: match[1] };
}

function getReviewMetadataValue(metadata, label) {
  return getLabelSection(metadata, label);
}

function stripDetailsBlocks(text) {
  return String(text).replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, '').trim();
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

export function getPrBodyWarnings(body, options = {}) {
  const warnings = [];
  const summary = getSectionBody(body, '## Summary');
  if (summary) {
    const visibleSummary = stripDetailsBlocks(summary);
    const paragraphs = visibleSummary.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
    paragraphs.forEach((paragraph, index) => {
      const wordCount = countWords(paragraph);
      if (wordCount > SUMMARY_WORD_LIMIT) {
        warnings.push(
          `Summary paragraph ${index + 1} is ${wordCount} words. Keep each Summary paragraph under ${SUMMARY_WORD_LIMIT} words.`,
        );
      }
    });
  }

  const changedFiles = options.changedFiles ?? [];
  if (changedFiles.length > 10) {
    warnings.push(`PR changes ${changedFiles.length} files. Split before review unless this is one mechanical/generated slice.`);
  }

  const units = reviewUnitsForChangedFiles(changedFiles);
  if (units.length > 2) {
    warnings.push(`PR spans ${units.length} review units: ${formatReviewUnits(units)}.`);
  }

  return warnings;
}

export async function validatePrBody(body, options = {}) {
  const errors = [];
  const trimmed = body.trim();

  if (!trimmed) {
    return [
      'PR body is empty. Use the canonical schema: ## Summary with a collapsed Review metadata block, ## Non-goals, ## Test Plan, and ## Revert Plan.',
    ];
  }

  for (const heading of REQUIRED_SECTIONS) {
    if (!trimmed.includes(heading)) {
      errors.push(`Missing required section: ${heading}`);
    }
  }
  for (const heading of VISIBLE_METADATA_SECTIONS) {
    if (trimmed.includes(heading)) {
      errors.push(`${heading} belongs in the collapsed Review metadata block inside ## Summary, not as a visible top-level section.`);
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

  const reviewMetadata = getReviewMetadataBlock(trimmed);
  if (!reviewMetadata.body) {
    errors.push('## Summary must include a collapsed <details> block with <summary>Review metadata</summary>.');
  } else if (/\bopen\b/i.test(reviewMetadata.openAttributes)) {
    errors.push('Review metadata details must be collapsed by default; remove the open attribute.');
  }

  for (const label of REQUIRED_METADATA_LABELS) {
    if (!getReviewMetadataValue(reviewMetadata.body, label)) {
      errors.push(`Review metadata is missing required field: ${label}:`);
    }
  }

  const reviewLane = normalizeSectionValue(getReviewMetadataValue(reviewMetadata.body, 'Review Lane'));
  if (reviewLane && !VALID_REVIEW_LANES.has(reviewLane)) {
    errors.push(`Invalid review lane: ${reviewLane}. Expected one of ${Array.from(VALID_REVIEW_LANES).join(', ')}.`);
  }

  const reviewUnit = normalizeReviewUnit(getReviewMetadataValue(reviewMetadata.body, 'Review Unit'));
  errors.push(...validateReviewUnitValue(reviewUnit, 'PR body'));
  errors.push(...validateReviewLaneUnitCompatibility({
    reviewLane,
    reviewUnit,
    context: 'PR body',
  }));

  const reviewClaim = getReviewMetadataValue(reviewMetadata.body, 'Review Claim');
  if (reviewClaim && !reviewClaim.trim()) {
    errors.push('Review metadata field Review Claim must not be empty.');
  }
  errors.push(...validateReviewUnitFocus({
    declaredReviewUnit: reviewUnit,
    context: 'PR body',
    texts: [
      stripDetailsBlocks(getSectionBody(trimmed, '## Summary')),
      reviewClaim,
      getReviewMetadataValue(reviewMetadata.body, 'Slice Rationale'),
    ],
  }));

  errors.push(...await validateMermaidBlocks(trimmed, { context: 'PR body' }));

  if (options.requiresVisualProof && !hasVisualProofMedia(trimmed)) {
    errors.push(
      'UI-impacting changes require a ## Visual Proof section with at least one screenshot image or video/walkthrough link.',
    );
  }

  if (reviewLane && options.changedFiles?.length) {
    errors.push(...validatePrScope({ changedFiles: options.changedFiles, reviewLane, body: trimmed }));
    errors.push(...validateReviewUnitChangedFiles({
      declaredReviewUnit: reviewUnit,
      changedFiles: options.changedFiles,
      context: 'PR body',
    }));
  }

  return errors;
}

function usage() {
  console.error(`Usage: node scripts/validate-pr-body.mjs (--body-file <file> | --body <markdown>) [--require-visual-proof]

Validates the canonical PR schema:
  Required: ## Summary with a collapsed Review metadata block, ## Non-goals, ## Test Plan, ## Revert Plan
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const body = args.bodyFile ? readFileSync(args.bodyFile, 'utf-8') : args.body;
  const errors = await validatePrBody(body, { requiresVisualProof: args.requiresVisualProof });
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
  await main();
}
