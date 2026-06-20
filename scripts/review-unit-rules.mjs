const PRODUCT_REVIEW_UNITS = new Set([
  'contract',
  'ownership-refactor',
  'read-path',
  'validation-policy',
  'write-path',
  'routing',
  'activation-surface',
  'tooling-policy',
  'cleanup',
]);

const UNIT_PATTERNS = [
  ['contract', [
    /\bcontracts?\b/,
    /\binterfaces?\b/,
    /\btypes?\b/,
    /\bports?\b/,
    /\bschemas?\b/,
  ]],
  ['ownership-refactor', [
    /\bownership\b/,
    /\brefactor\b/,
    /\bextract(?:s|ed|ing)?\b/,
    /\bsplit(?:s|ting)?\b/,
    /\bmove(?:s|d)?\b/,
    /\bmoved\b/,
  ]],
  ['read-path', [
    /\bscan(?:s|ned|ning)?\b/,
    /\benumerat(?:e|es|ed|ing)\b/,
    /\blist(?:s|ed|ing)?\b/,
    /\bdiscover(?:s|ed|ing)?\b/,
  ]],
  ['validation-policy', [
    /\bvalidat(?:e|es|ed|ing|ion)\b/,
    /\beligib(?:le|ility)\b/,
    /\bineligible\b/,
    /\bstale\b/,
    /\bretr(?:y|ies)\b/,
    /\bdedupe\b/,
    /\bdeduplicat(?:e|es|ed|ing|ion)\b/,
    /\bduplicates?\b/,
    /\bsuppress(?:es|ed|ing)?\b/,
    /\bskip(?:s|ped|ping)?\b/,
    /\breject(?:s|ed|ing)?\b/,
    /\balready queued\b/,
    /\bopen fix intents?\b/,
  ]],
  ['write-path', [
    /\bsubmit(?:s|ted|ting)?\b/,
    /\benqueue(?:s|d|ing)?\b/,
    /\bcreate(?:s|d|ing)?\s+(?:a\s+)?(?:workflow\s+)?mutation intents?\b/,
    /\bfix-with-agent\b/,
  ]],
  ['routing', [
    /\broute(?:s|d|ing)?\b/,
    /\brouting\b/,
    /\bwakeups?\b/,
    /\bmessage bus\b/,
    /\bsubscriptions?\b/,
    /\blifecycle events?\b/,
  ]],
  ['activation-surface', [
    /\bactivate(?:s|d|ing)?\b/,
    /\bactivation\b/,
    /\bexpose(?:s|d|ing)?\b/,
    /\bheadless\b/,
    /\bcli\b/,
    /\bcommands?\b/,
  ]],
  ['tooling-policy', [
    /\bskill-doctor\b/,
    /\bplan-to-invoker\b/,
    /\bvalidators?\b/,
    /\blint(?:er|ing)?\b/,
    /\bpr bod(?:y|ies)\b/,
    /\bcreate-pr\b/,
    /\bmergify\b/,
    /\bci policy\b/,
  ]],
  ['proof', [
    /\btests?\b/,
    /\bregression\b/,
    /\brepros?\b/,
    /\bbenchmarks?\b/,
    /\bproof\b/,
    /\bverification\b/,
    /\bvisual proof\b/,
  ]],
  ['docs', [
    /\bdocs?\b/,
    /\bdocumentation\b/,
    /\breadme\b/,
    /\bskill\.md\b/,
  ]],
  ['cleanup', [
    /\bcleanup\b/,
    /\bdelete(?:s|d|ing)?\b/,
    /\bremove(?:s|d|ing)?\b/,
    /\bdead code\b/,
  ]],
];

const ALLOWED_CHANGE_OPERATIONS = new Set([
  'create',
  'modify',
  'delete',
  'rename',
  'move',
  'config-only',
  'test-only',
  'docs-only',
  'generated',
  'none',
]);

const PATH_LIKE = /^(?:packages|scripts|skills|docs|plans|\.github|[A-Za-z0-9_.-]+\/)[^:]+/;

export function firstMeaningfulLine(value = '') {
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
}

export function getMarkdownSection(body, heading) {
  const lines = String(body).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) return '';

  const sectionLines = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    sectionLines.push(line);
  }
  return sectionLines.join('\n').trim();
}

export function getLabelSection(text, label) {
  const labelPattern = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|\\n)\\s*${labelPattern}:\\s*`, 'i');
  const match = pattern.exec(String(text));
  if (!match) return '';

  const start = match.index + match[0].length;
  const rest = String(text).slice(start);
  const nextHeading = /\n\s*[A-Za-z][A-Za-z _-]*:\s*/.exec(rest);
  return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
}

export function detectReviewUnits(text) {
  const haystack = String(text).toLowerCase();
  const detected = new Set();
  for (const [unit, patterns] of UNIT_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(haystack))) {
      detected.add(unit);
    }
  }
  return detected;
}

function includedWorkText(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => !/\b(separate|non-goals?|do not|does not|without|no\s+)\b/i.test(line))
    .join('\n');
}

export function validateSingleReviewUnitFocus({ texts = [], context }) {
  const errors = [];

  const detected = new Set();
  for (const text of texts) {
    for (const unit of detectReviewUnits(includedWorkText(text))) {
      detected.add(unit);
    }
  }

  const detectedProductUnits = Array.from(detected).filter((unit) => PRODUCT_REVIEW_UNITS.has(unit));
  if (detectedProductUnits.length > 1) {
    errors.push(
      `${context} mentions multiple review units (${detectedProductUnits.sort().join(', ')}); split into one conceptual unit per diff/task.`,
    );
  }

  if (detected.has('docs') && detectedProductUnits.length > 0) {
    errors.push(`${context} mixes docs language with product-unit language; split docs from implementation policy.`);
  }

  return errors;
}

export function parseChangeTypeItems(section) {
  return String(section)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

export function validateChangeTypeItems(section, context) {
  const errors = [];
  for (const item of parseChangeTypeItems(section)) {
    const lower = item.toLowerCase();
    const directOperation = ALLOWED_CHANGE_OPERATIONS.has(lower);
    const [pathPart, opPart = ''] = item.split(':', 2).map((part) => part.trim());
    const operation = opPart.toLowerCase().split(/\s+/)[0] ?? '';
    const pathWithOperation = PATH_LIKE.test(pathPart) && ALLOWED_CHANGE_OPERATIONS.has(operation);
    if (directOperation || pathWithOperation) continue;

    const detectedUnits = Array.from(detectReviewUnits(item)).filter((unit) => PRODUCT_REVIEW_UNITS.has(unit));
    if (detectedUnits.length > 0 || /\b(add|implement|wire|route|validate|submit|scan)\b/i.test(item)) {
      errors.push(
        `${context} Change types entry "${item}" is conceptual work, not a per-file operation. Use entries like "packages/app/src/file.ts: modify" and keep conceptual work in Review Claim or Slice Rationale.`,
      );
    }
  }
  return errors;
}
