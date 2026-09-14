export const VALID_REVIEW_UNITS = [
  'contract',
  'ownership-refactor',
  'read-path',
  'validation-policy',
  'write-path',
  'routing',
  'activation-surface',
  'tooling-policy',
  'proof',
  'docs',
  'cleanup',
];

const VALID_REVIEW_UNIT_SET = new Set(VALID_REVIEW_UNITS);
const PRODUCT_REVIEW_UNITS = new Set([
  'contract',
  'ownership-refactor',
  'read-path',
  'validation-policy',
  'write-path',
  'routing',
  'activation-surface',
  'cleanup',
]);

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

const PATH_LIKE = /^(?:packages|scripts|skills|docs|plans|\.github|[A-Za-z0-9_.-]+\/)[^:]+|^[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/;
const APP_SRC_PREFIX = 'packages/app/src/';
const REVIEW_GATE_PUBLICATION_PATH = 'packages/execution-engine/src/merge-runner.ts';
const REVIEW_GATE_POLLING_PATH = 'packages/execution-engine/src/task-runner.ts';


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

export function normalizeReviewUnit(value = '') {
  return firstMeaningfulLine(value).replace(/^[-*]\s*/, '').trim().toLowerCase();
}

export function validateReviewUnitValue(reviewUnit, context) {
  if (!reviewUnit) return [];
  if (VALID_REVIEW_UNIT_SET.has(reviewUnit)) return [];

  return [`Invalid review unit: ${reviewUnit}. Expected one of ${VALID_REVIEW_UNITS.join(', ')}.`];
}

export function validateReviewLaneUnitCompatibility({ reviewLane = '', reviewUnit = '', context }) {
  if (!reviewLane || !VALID_REVIEW_UNIT_SET.has(reviewUnit)) return [];

  const productUnits = new Set([
    'contract',
    'ownership-refactor',
    'read-path',
    'validation-policy',
    'write-path',
    'routing',
    'activation-surface',
  ]);

  if ((reviewLane === 'behavior' || reviewLane === 'refactor') && productUnits.has(reviewUnit)) return [];
  if (reviewLane === 'cleanup' && reviewUnit === 'cleanup') return [];
  if (reviewLane === 'policy' && reviewUnit === 'tooling-policy') return [];
  if (reviewLane === 'proof' && reviewUnit === 'proof') return [];
  if (reviewLane === 'docs' && reviewUnit === 'docs') return [];

  return [`${context} Review Lane "${reviewLane}" is not compatible with Review Unit "${reviewUnit}".`];
}

export function classifyReviewUnitsForPath(filePath) {
  const path = String(filePath).replace(/\\/g, '/');
  const lowerPath = path.toLowerCase();
  const basename = path.split('/').pop() ?? '';

  if (path.startsWith('scripts/repro/')) return ['proof'];
  if (
    path === 'scripts/pr-body-template.md'
    || path === 'scripts/test-create-pr-visual-proof.mjs'
    || path.startsWith('scripts/fixtures/')
  ) return ['tooling-policy'];
  if (path.startsWith('packages/app/e2e/visual-proof/')) return ['activation-surface'];
  if (/(benchmark|performance)/.test(lowerPath)) return ['proof'];
  if (/visual-proof/.test(lowerPath) && path.includes('/e2e/')) return ['proof'];
  if (
    path === 'skills/make-pr/SKILL.md'
    || path.startsWith('skills/chat-submit/')
    || path.startsWith('skills/plan-to-invoker/')
    || path.startsWith('skills/workflow-chain-submit/')
    || path === 'skills/land-stack/SKILL.md'
    || path === 'skills/visual-proof/SKILL.md'
    || path === 'skills/prove-it/SKILL.md'
  ) return ['tooling-policy'];
  if (path.startsWith('docs/') || path.startsWith('skills/') || path.endsWith('.md')) return ['docs'];
  if (path.startsWith('.github/')) return ['tooling-policy'];
  if (
    path === 'package.json'
    || path === 'pnpm-lock.yaml'
    || /^tsconfig.*\.json$/.test(path)
    || /^packages\/[^/]+\/package\.json$/.test(path)
    || /^packages\/[^/]+\/tsconfig.*\.json$/.test(path)
  ) {
    return [];
  }
  if (path === 'run.sh') return ['tooling-policy'];
  if (path.startsWith('scripts/')) return ['tooling-policy'];
  if (
    path.startsWith('packages/')
    && (path.includes('/e2e/') || path.includes('/__tests__/') || /\.(spec|test)\.[^.]+$/.test(path))
  ) {
    return [];
  }
  if (path.startsWith('packages/contracts/')) return ['contract'];
  if (
    path.startsWith('packages/cli/')
    || path.startsWith('packages/npm-cli/')
    || path.startsWith('packages/npm-ui/bin/')
    || path.startsWith('packages/ui/')
    || path.startsWith('packages/app/src/window/')
    || path === 'packages/app/src/preload.ts'
    || path === 'packages/app/src/app-menu.ts'
    || path === 'packages/app/src/headless.ts'
    || /^packages\/app\/src\/headless-[^/]+\.ts$/.test(path)
    || path === 'packages/app/src/api-server.ts'
    || path === 'packages/app/src/workflow-actions.ts'
    || path === 'packages/app/src/workflow-mutation-facade.ts'
    || path === 'packages/app/src/web/web-invoker-dispatch.ts'
    || path.startsWith('packages/app/src/ipc/')
  ) {
    return ['activation-surface'];
  }
  if (
    path.startsWith('packages/workflow-core/')
    || path.startsWith('packages/execution-engine/')
    || path === 'packages/app/src/launch-dispatcher.ts'
    || path === 'packages/app/src/global-topup.ts'
    || path === 'packages/app/src/main.ts'
    || path === 'packages/app/src/workflow-mutation-facade.ts'
    || path === 'packages/app/src/headless-standalone-launch-dispatcher.ts'
  ) {
    return ['routing'];
  }
  if (path.startsWith(APP_SRC_PREFIX) && /(gating|policy|validator|validation|eligibility|config)/.test(basename)) {
    return ['validation-policy'];
  }
  if (path.startsWith(APP_SRC_PREFIX) && /(recovery|scanner|store|persistence)/.test(basename)) {
    return ['read-path'];
  }
  if (path.startsWith(APP_SRC_PREFIX)) return ['routing'];
  return [];
}

export function reviewUnitsForChangedFiles(changedFiles = []) {
  const units = new Set();
  for (const changedFile of changedFiles) {
    for (const unit of classifyReviewUnitsForPath(changedFile)) {
      units.add(unit);
    }
  }
  return VALID_REVIEW_UNITS.filter((unit) => units.has(unit));
}

export function formatReviewUnits(units) {
  const unitSet = new Set(units);
  return VALID_REVIEW_UNITS.filter((unit) => unitSet.has(unit)).join(', ');
}

export function parseFileListItems(section) {
  return String(section)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter((line) => line && !/\s/.test(line));
}

export function validateSingleReviewUnitFiles({ files = [], context }) {
  if (files.length === 0) return [];
  const units = reviewUnitsForChangedFiles(files);
  if (units.length <= 1) return [];
  return [
    `${context} lists files from ${formatReviewUnits(units)}; split into one review unit per task.`,
  ];
}

export function validateReviewUnitChangedFiles({ declaredReviewUnit, changedFiles = [], context }) {
  if (!VALID_REVIEW_UNIT_SET.has(declaredReviewUnit) || changedFiles.length === 0) return [];

  const forbidden = reviewUnitsForChangedFiles(changedFiles).filter((unit) => unit !== declaredReviewUnit);
  if (forbidden.length === 0) return [];

  return [
    `${context} Review Unit "${declaredReviewUnit}" cannot ship with ${formatReviewUnits(forbidden)} files in the same PR. Split this into one Review Unit per PR.`,
  ];
}

export function validateKnownReviewBoundaries({ reviewLane = '', changedFiles = [], context }) {
  if (!['behavior', 'refactor'].includes(reviewLane) || changedFiles.length === 0) return [];

  const changedFileSet = new Set(changedFiles);
  if (
    !changedFileSet.has(REVIEW_GATE_PUBLICATION_PATH)
    || !changedFileSet.has(REVIEW_GATE_POLLING_PATH)
  ) {
    return [];
  }

  return [
    `${context} Publication and poll/approval runtime behavior must be split into separate PRs. Do not change ${REVIEW_GATE_PUBLICATION_PATH} and ${REVIEW_GATE_POLLING_PATH} in the same PR.`,
  ];
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

    errors.push(
      `${context} Change types entry "${item}" is conceptual work, not a per-file operation. Use entries like "packages/app/src/file.ts: modify" and keep conceptual work in Review Claim or Slice Rationale.`,
    );
  }
  return errors;
}
