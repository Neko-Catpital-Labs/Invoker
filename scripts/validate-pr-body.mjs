#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { collectDiffAtomicityFindings, formatDiffAtomicityFindings } from './lint-pr-diff-atomicity.mjs';
import {
  formatReviewUnits,
  getLabelSection,
  getMarkdownSection,
  normalizeReviewUnit,
  reviewUnitsForChangedFiles,
  validateKnownReviewBoundaries,
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
const REQUIRED_METADATA_SECTIONS = [
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
const COLLAPSED_PLAN_SECTIONS = [
  { heading: '## Test Plan', label: 'Test Plan' },
  { heading: '## Revert Plan', label: 'Revert Plan' },
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

function getCollapsedPlanBlock(body, heading, label) {
  const section = getSectionBody(body, heading);
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = section.match(new RegExp(
    `<details\\b([^>]*)>\\s*<summary>\\s*${escaped}\\s*</summary>([\\s\\S]*?)</details>`,
    'i',
  ));
  if (!match) return null;
  return { body: match[2].trim(), openAttributes: match[1] };
}

function countWords(text) {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function getVisualProofBody(body) {
  return getSectionBody(body, '## Visual Proof');
}

function hasVisualProofMedia(body) {
  const visualProof = getVisualProofBody(body);
  if (!visualProof) return false;

  return /!\[[^\]]*\]\([^)]+\)/.test(visualProof)
    || /\[[^\]]*(?:video|walkthrough|recording|animation|gif)[^\]]*\]\([^)]+\)/i.test(visualProof)
    || /\bhttps?:\/\/\S+\.(?:png|jpe?g|gif|webp|webm|mp4)\b/i.test(visualProof);
}

function hasAnimatedVisualProofMedia(body) {
  const visualProof = getVisualProofBody(body);
  if (!visualProof) return false;

  return /!\[[^\]]*\]\([^)]+\.(?:gif|webm|mp4)(?:\?[^)]*)?\)/i.test(visualProof)
    || /\[[^\]]*(?:video|walkthrough|recording|animation|gif)[^\]]*\]\([^)]+\)/i.test(visualProof)
    || /\bhttps?:\/\/\S+\.(?:gif|webm|mp4)\b/i.test(visualProof);
}

function visualProofNeedsAnimation(body) {
  const visualProof = getVisualProofBody(body);
  if (!visualProof) return false;

  return (
    /\brestart|relaunch|reload\b/i.test(visualProof)
    || /\btransition|state change\b/i.test(visualProof)
    || (/\bbefore\b/i.test(visualProof) && /\bafter\b/i.test(visualProof))
  );
}

function getLegacyReviewMetadataBlock(body) {
  const summary = getSectionBody(body, '## Summary');
  const match = summary.match(/<details\b([^>]*)>\s*<summary>\s*Review metadata\s*<\/summary>([\s\S]*?)<\/details>/i);
  if (!match) return { body: '', openAttributes: '' };
  return { body: match[2].trim(), openAttributes: match[1] };
}

function hasVisibleReviewMetadata(body) {
  return REQUIRED_METADATA_SECTIONS.some((heading) => getSectionBody(body, heading));
}

function normalizeSectionValue(sectionBody) {
  return normalizeReviewUnit(sectionBody);
}

export function getReviewMetadata(body) {
  if (hasVisibleReviewMetadata(body)) {
    return {
      reviewClaim: getSectionBody(body, '## Review Claim'),
      reviewLane: normalizeSectionValue(getSectionBody(body, '## Review Lane')),
      reviewUnit: normalizeReviewUnit(getSectionBody(body, '## Review Unit')),
      safetyInvariant: getSectionBody(body, '## Safety Invariant'),
      sliceRationale: getSectionBody(body, '## Slice Rationale'),
    };
  }

  const legacy = getLegacyReviewMetadataBlock(body);
  return {
    reviewClaim: getLabelSection(legacy.body, 'Review Claim'),
    reviewLane: normalizeSectionValue(getLabelSection(legacy.body, 'Review Lane')),
    reviewUnit: normalizeReviewUnit(getLabelSection(legacy.body, 'Review Unit')),
    safetyInvariant: getLabelSection(legacy.body, 'Safety Invariant'),
    sliceRationale: getLabelSection(legacy.body, 'Slice Rationale'),
  };
}

function stripDetailsBlocks(text) {
  return String(text).replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, '').trim();
}

function classifyScopeKind(filePath) {
  const path = filePath.replace(/\\/g, '/');

  if (path.startsWith('scripts/repro/')) return 'proof';
  if (path.startsWith('packages/app/e2e/visual-proof/')) return 'product-test';
  if (path.startsWith('skills/') || path.startsWith('docs/') || path.endsWith('.md')) return 'docs';
  if (path.startsWith('scripts/')) return 'policy';
  if (
    path.includes('/e2e/')
    || path.includes('/__tests__/')
    || /\.(spec|test)\.[jt]sx?$/.test(path)
  ) {
    if (/(benchmark|performance)/.test(path)) return 'proof';
    return 'product-test';
  }
  if (/(benchmark|performance)/.test(path)) return 'proof';
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

export function getPrAtomicityBlockers(options = {}) {
  const diffText = options.diffText ?? '';
  if (!diffText) return [];

  return collectDiffAtomicityFindings({ diffText })
    .filter((finding) => finding.severity === 'warning')
    .map((finding) => `Diff atomicity blocker: ${formatDiffAtomicityFindings([finding])[0]}`);
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

  if (options.diffText) {
    const diffWarnings = collectDiffAtomicityFindings({ diffText: options.diffText })
      .filter((finding) => finding.severity === 'warning');
    for (const line of formatDiffAtomicityFindings(diffWarnings)) {
      warnings.push(`Diff atomicity warning: ${line}`);
    }
  }

  return warnings;
}

export async function validatePrBody(body, options = {}) {
  const errors = [];
  const trimmed = body.trim();
  if (!trimmed) {
    return [
      'PR body is empty. Use the canonical schema: ## Summary, ## Review Claim, ## Review Lane, ## Review Unit, ## Safety Invariant, ## Slice Rationale, ## Non-goals, and ## Test Plan and ## Revert Plan with collapsed details blocks.',
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

  const legacyReviewMetadata = getLegacyReviewMetadataBlock(trimmed);
  const reviewMetadataFromVisibleSections = hasVisibleReviewMetadata(trimmed);
  if (legacyReviewMetadata.body && !reviewMetadataFromVisibleSections) {
    errors.push('Do not hide review metadata in <details>. Use visible ## Review Claim / ## Review Lane / ## Review Unit / ## Safety Invariant / ## Slice Rationale sections.');
  }

  const reviewMetadata = getReviewMetadata(trimmed);
  const reviewClaim = reviewMetadata.reviewClaim;
  const reviewLane = reviewMetadata.reviewLane;
  const reviewUnit = reviewMetadata.reviewUnit;
  const safetyInvariant = reviewMetadata.safetyInvariant;
  const sliceRationale = reviewMetadata.sliceRationale;

  if (reviewMetadataFromVisibleSections) {
    for (const heading of REQUIRED_METADATA_SECTIONS) {
      if (!getSectionBody(trimmed, heading)) {
        errors.push(`Missing required section: ${heading}`);
      }
    }
  } else if (!legacyReviewMetadata.body) {
    errors.push('Missing review metadata. Add visible ## Review Claim / ## Review Lane / ## Review Unit / ## Safety Invariant / ## Slice Rationale sections.');
  } else {
    for (const label of REQUIRED_METADATA_LABELS) {
      if (!getLabelSection(legacyReviewMetadata.body, label)) {
        errors.push(`Review metadata is missing required field: ${label}:`);
      }
    }
  }

  for (const { heading, label } of COLLAPSED_PLAN_SECTIONS) {
    if (!trimmed.includes(heading)) continue;
    const block = getCollapsedPlanBlock(trimmed, heading, label);
    if (!block) {
      errors.push(`${heading} must wrap its content in a collapsed <details> block with <summary>${label}</summary>.`);
      continue;
    }
    if (/\bopen\b/i.test(block.openAttributes)) {
      errors.push(`${label} details must be collapsed by default; remove the open attribute.`);
    }
    if (!block.body) {
      errors.push(`${label} details block must not be empty.`);
    }
  }

  if (reviewLane && !VALID_REVIEW_LANES.has(reviewLane)) {
    errors.push(`Invalid review lane: ${reviewLane}. Expected one of ${Array.from(VALID_REVIEW_LANES).join(', ')}.`);
  }

  errors.push(...validateReviewUnitValue(reviewUnit, 'PR body'));
  errors.push(...validateReviewLaneUnitCompatibility({
    reviewLane,
    reviewUnit,
    context: 'PR body',
  }));

  if (reviewClaim && !reviewClaim.trim()) {
    errors.push('## Review Claim must not be empty.');
  }
  if (safetyInvariant && !safetyInvariant.trim()) {
    errors.push('## Safety Invariant must not be empty.');
  }
  if (sliceRationale && !sliceRationale.trim()) {
    errors.push('## Slice Rationale must not be empty.');
  }
  errors.push(...validateReviewUnitFocus({
    declaredReviewUnit: reviewUnit,
    context: 'PR body',
    texts: [
      getSectionBody(trimmed, '## Summary'),
      reviewClaim,
      sliceRationale,
    ],
  }));

  errors.push(...await validateMermaidBlocks(trimmed, { context: 'PR body' }));

  if (options.requiresVisualProof && !hasVisualProofMedia(trimmed)) {
    errors.push(
      'UI-impacting changes require a ## Visual Proof section with at least one screenshot image or video/walkthrough link.',
    );
  } else if (options.requiresVisualProof && visualProofNeedsAnimation(trimmed) && !hasAnimatedVisualProofMedia(trimmed)) {
    errors.push(
      'Restart or multi-state visual proof must include animated media such as a gif, webm, mp4, or walkthrough/video link.',
    );
  }

  if (reviewLane && options.changedFiles?.length) {
    errors.push(...validatePrScope({ changedFiles: options.changedFiles, reviewLane, body: trimmed }));
    errors.push(...validateReviewUnitChangedFiles({
      declaredReviewUnit: reviewUnit,
      changedFiles: options.changedFiles,
      context: 'PR body',
    }));
    errors.push(...validateKnownReviewBoundaries({
      reviewLane,
      changedFiles: options.changedFiles,
      context: 'PR body',
    }));
  }

  if (options.diffText) {
    const fatalFindings = collectDiffAtomicityFindings({ diffText: options.diffText })
      .filter((finding) => finding.severity === 'fatal');
    for (const line of formatDiffAtomicityFindings(fatalFindings)) {
      errors.push(`Diff atomicity violation: ${line}`);
    }
  }

  return errors;
}

function usage() {
  console.error(`Usage: node scripts/validate-pr-body.mjs (--body-file <file> | --body <markdown>) [--require-visual-proof] [--changed-files-file <file>] [--diff-file <file>]

Validates the canonical PR schema:
  Required: ## Summary, ## Review Claim, ## Review Lane, ## Review Unit, ## Safety Invariant, ## Slice Rationale, ## Non-goals, ## Test Plan, ## Revert Plan
  Test Plan and Revert Plan content must sit inside a collapsed <details><summary>Test Plan</summary> / <summary>Revert Plan</summary> block.
  Optional: ## Architecture (must include ### Before and ### After when present)
  UI changes: pass --require-visual-proof to require screenshot or video proof; restart or multi-state proof must be animated.
  --changed-files-file <file>  Newline-separated changed file paths for scope checks.
  --diff-file <file>           Unified diff text to run the diff atomicity engine.`);
  process.exit(1);
}

function parseArgs(argv) {
  let body = '';
  let bodyFile = '';
  let requiresVisualProof = false;
  let changedFilesFile = '';
  let diffFile = '';

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
      case '--changed-files-file':
        changedFilesFile = argv[++i];
        if (!changedFilesFile || changedFilesFile.startsWith('--')) {
          console.error('--changed-files-file requires a file path.');
          usage();
        }
        break;
      case '--diff-file':
        diffFile = argv[++i];
        if (!diffFile || diffFile.startsWith('--')) {
          console.error('--diff-file requires a file path.');
          usage();
        }
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

  return { body, bodyFile, requiresVisualProof, changedFilesFile, diffFile };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const body = args.bodyFile ? readFileSync(args.bodyFile, 'utf-8') : args.body;
  const changedFiles = args.changedFilesFile
    ? readFileSync(args.changedFilesFile, 'utf-8').split('\n').map((line) => line.trim()).filter(Boolean)
    : undefined;
  const diffText = args.diffFile ? readFileSync(args.diffFile, 'utf-8') : undefined;
  const errors = await validatePrBody(body, { requiresVisualProof: args.requiresVisualProof, changedFiles, diffText });
  const warnings = getPrBodyWarnings(body, { changedFiles, diffText });

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
