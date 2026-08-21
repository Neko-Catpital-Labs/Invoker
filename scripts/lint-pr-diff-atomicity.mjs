#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let typescriptModule;

const CODE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
/** Extensions consulted by the refactor-dead-symbol check only; CODE_EXTENSIONS stays TS-AST-only. */
const DEFINITION_EXTENSIONS = new Set([...CODE_EXTENSIONS, '.py']);
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lockb']);
const MANIFESTS = new Set(['package.json']);
const GENERATED_DIRS = new Set(['dist', 'out', 'build', 'coverage', '.next', '__generated__']);
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt']);
const CONFIG_EXTENSIONS = new Set(['.yml', '.yaml', '.json', '.toml', '.ini']);
const TEST_FUNCTIONS = new Set(['describe', 'it', 'test', 'context', 'suite']);

const POLICY = {
  'mixed-generated-and-source': {
    severity: 'fatal',
    message: 'Generated or build-output files are mixed with hand-written source in one diff; split them into separate PRs.',
  },
  'orphaned-lockfile': {
    severity: 'fatal',
    message: 'A dependency lockfile changed without a matching package manifest change; isolate lockfile churn in its own PR.',
  },
  'debugger-statement': {
    severity: 'fatal',
    message: 'A debugger statement was added to source; remove debug scaffolding before review.',
  },
  'focused-test': {
    severity: 'fatal',
    message: 'A focused test (.only) was added; it silently skips the rest of the suite.',
  },
  'skipped-test': {
    severity: 'warning',
    message: 'A skipped test (.skip) was added; confirm the skip is intentional.',
  },
  'test-assertion-weakened': {
    severity: 'fatal',
    message: 'A test assertion was flipped (negation or expected value changed) in the same diff as a non-test file change; confirm the test still catches the original bug instead of matching a regression.',
  },
  'unrelated-areas': {
    severity: 'warning',
    message: 'The diff spans multiple unrelated top-level areas; confirm this is one atomic change.',
  },
  'refactor-dead-symbol': {
    severity: 'warning',
    message: 'A refactor-lane PR adds a symbol with no reference anywhere else in the diff; confirm the extraction also re-pointed its call sites in this PR.',
  },
  'refactor-multiple-symbols': {
    severity: 'warning',
    message: 'A refactor-lane PR touches more than one top-level symbol in this diff; confirm this is one cohesive move (see the dependency-cluster exception in the review-compression skill\'s Decomposition & Extraction Refactors section) or split into separate PRs.',
  },
};

function stripPrefix(marker) {
  const trimmed = marker.trim();
  if (trimmed === '/dev/null') {
    return '/dev/null';
  }
  if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) {
    return trimmed.slice(2);
  }
  return trimmed;
}

function classifyPath(filePath) {
  const normalized = filePath.split(path.sep).join('/');
  const basename = path.basename(normalized);
  const extension = path.extname(basename);
  const parts = normalized.split('/');

  if (LOCKFILES.has(basename)) {
    return 'lockfile';
  }
  if (MANIFESTS.has(basename)) {
    return 'manifest';
  }
  if (parts.some((part) => GENERATED_DIRS.has(part)) || basename.includes('.generated.') || basename.includes('.gen.') || basename.endsWith('.min.js')) {
    return 'generated';
  }
  if (basename.includes('.test.') || basename.includes('.spec.') || basename.startsWith('test-') || parts.includes('__tests__') || parts.includes('tests')) {
    return 'test';
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return 'source';
  }
  if (DOC_EXTENSIONS.has(extension) || parts.includes('docs')) {
    return 'docs';
  }
  if (CONFIG_EXTENSIONS.has(extension) || parts.includes('.github')) {
    return 'config';
  }
  return 'other';
}

function getTypeScript() {
  if (!typescriptModule) {
    typescriptModule = require('typescript');
  }
  return typescriptModule;
}

function scriptKindFor(ts, filePath) {
  const extension = path.extname(filePath);
  if (extension === '.tsx') {
    return ts.ScriptKind.TSX;
  }
  if (extension === '.ts') {
    return ts.ScriptKind.TS;
  }
  if (extension === '.jsx') {
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.JS;
}

function topArea(filePath) {
  const parts = filePath.split('/');
  if (parts[0] === 'packages' && parts.length > 1) {
    return `packages/${parts[1]}`;
  }
  return parts[0] || filePath;
}

function finalizeFile(file) {
  if (!file) {
    return null;
  }
  const max = file.newLineMap.size > 0 ? Math.max(...file.newLineMap.keys()) : 0;
  const lines = new Array(max).fill('');
  for (const [lineNumber, text] of file.newLineMap) {
    lines[lineNumber - 1] = text;
  }
  file.newContent = lines.join('\n');

  const oldMax = file.oldLineMap.size > 0 ? Math.max(...file.oldLineMap.keys()) : 0;
  const oldLines = new Array(oldMax).fill('');
  for (const [lineNumber, text] of file.oldLineMap) {
    oldLines[lineNumber - 1] = text;
  }
  file.oldContent = oldLines.join('\n');

  file.category = classifyPath(file.path);
  delete file.newLineMap;
  delete file.oldLineMap;
  return file;
}

export function parseUnifiedDiff(diffText, source = 'diff') {
  const files = [];
  const lines = (diffText || '').split('\n');
  let current = null;
  let counter = 0;
  let oldCounter = 0;

  const start = (header) => {
    const finalized = finalizeFile(current);
    if (finalized) {
      files.push(finalized);
    }
    current = {
      source,
      header,
      oldPath: '',
      newPath: '',
      path: '',
      changeType: 'modify',
      addedLineNumbers: new Set(),
      removedLineNumbers: new Set(),
      removedCount: 0,
      newLineMap: new Map(),
      oldLineMap: new Map(),
      newContent: '',
      oldContent: '',
      category: 'other',
    };
    counter = 0;
    oldCounter = 0;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      start(line);
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('new file mode')) {
      current.changeType = 'add';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.changeType = 'delete';
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.changeType = 'rename';
      current.oldPath = stripPrefix(line.slice('rename from '.length));
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.changeType = 'rename';
      current.newPath = stripPrefix(line.slice('rename to '.length));
      current.path = current.newPath;
      continue;
    }
    if (line.startsWith('--- ')) {
      current.oldPath = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      current.newPath = stripPrefix(line.slice(4));
      current.path = current.newPath === '/dev/null' ? current.oldPath : current.newPath;
      continue;
    }
    if (line.startsWith('@@')) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldCounter = match ? Number.parseInt(match[1], 10) : 0;
      counter = match ? Number.parseInt(match[2], 10) : 0;
      continue;
    }
    if (counter < 1 && oldCounter < 1) {
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.newLineMap.set(counter, line.slice(1));
      current.addedLineNumbers.add(counter);
      counter += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.oldLineMap.set(oldCounter, line.slice(1));
      current.removedLineNumbers.add(oldCounter);
      current.removedCount += 1;
      oldCounter += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      current.newLineMap.set(counter, line.slice(1));
      current.oldLineMap.set(oldCounter, line.slice(1));
      counter += 1;
      oldCounter += 1;
    }
  }

  const finalized = finalizeFile(current);
  if (finalized) {
    files.push(finalized);
  }

  return files;
}

function rootIdentifier(ts, node) {
  let expression = node;
  while (ts.isPropertyAccessExpression(expression)) {
    expression = expression.expression;
  }
  return ts.isIdentifier(expression) ? expression.text : '';
}

function collectAstFindings(file) {
  if (!CODE_EXTENSIONS.has(path.extname(file.path)) || file.category === 'generated') {
    return [];
  }
  const ts = getTypeScript();
  const findings = [];
  const sourceFile = ts.createSourceFile(file.path, file.newContent, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file.path));

  const record = (kind, node) => {
    const lineNumber = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    if (file.addedLineNumbers.has(lineNumber)) {
      findings.push(makeFinding(kind, file.path, lineNumber, file.source));
    }
  };

  const walk = (node) => {
    if (node.kind === ts.SyntaxKind.DebuggerStatement) {
      record('debugger-statement', node);
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
      const member = node.name.text;
      if ((member === 'only' || member === 'skip') && TEST_FUNCTIONS.has(rootIdentifier(ts, node.expression))) {
        record(member === 'only' ? 'focused-test' : 'skipped-test', node);
      }
    }
    ts.forEachChild(node, walk);
  };

  walk(sourceFile);
  return findings;
}

function analyzeAssertionCall(ts, node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || !ts.isIdentifier(node.expression.name)) {
    return null;
  }
  const matcherName = node.expression.name.text;
  const matcherArgs = node.arguments.map((arg) => arg.getText()).join(', ');

  let cursor = node.expression.expression;
  let negated = false;
  while (ts.isPropertyAccessExpression(cursor) && ts.isIdentifier(cursor.name)) {
    if (cursor.name.text === 'not') {
      negated = true;
    }
    cursor = cursor.expression;
  }
  if (!ts.isCallExpression(cursor) || !ts.isIdentifier(cursor.expression) || cursor.expression.text !== 'expect') {
    return null;
  }
  const target = cursor.arguments.map((arg) => arg.getText()).join(', ').trim();
  return { target, matcherName, matcherArgs, negated };
}

function collectAssertionCalls(file, content, lineNumbers) {
  if (!CODE_EXTENSIONS.has(path.extname(file.path)) || lineNumbers.size === 0) {
    return [];
  }
  const ts = getTypeScript();
  const sourceFile = ts.createSourceFile(file.path, content, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file.path));
  const assertions = [];

  const walk = (node) => {
    const assertion = analyzeAssertionCall(ts, node);
    if (assertion) {
      // Match on the call's full line RANGE, not just its start line: an
      // expected-value edit inside a multi-line argument list leaves the
      // `expect(` line untouched and must still count as a changed assertion.
      const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      let touchesChangedLine = false;
      for (let line = startLine; line <= endLine; line += 1) {
        if (lineNumbers.has(line)) {
          touchesChangedLine = true;
          break;
        }
      }
      if (touchesChangedLine) {
        assertions.push({ ...assertion, line: startLine });
      }
    }
    ts.forEachChild(node, walk);
  };

  walk(sourceFile);
  return assertions;
}

function collectTestAssertionWeakenedFindings(files) {
  const hasNonTestFile = files.some((file) => file.category !== 'test' && file.path && file.path !== '/dev/null');
  if (!hasNonTestFile) {
    return [];
  }

  const findings = [];
  for (const file of files) {
    if (file.category !== 'test') {
      continue;
    }
    const removedAssertions = collectAssertionCalls(file, file.oldContent, file.removedLineNumbers);
    if (removedAssertions.length === 0) {
      continue;
    }
    const addedAssertions = collectAssertionCalls(file, file.newContent, file.addedLineNumbers);
    for (const added of addedAssertions) {
      const flipped = removedAssertions.some((removed) =>
        removed.target === added.target
        && removed.matcherName === added.matcherName
        && (removed.negated !== added.negated || removed.matcherArgs !== added.matcherArgs));
      if (flipped) {
        findings.push(makeFinding('test-assertion-weakened', file.path, added.line, file.source));
      }
    }
  }
  return findings;
}

const PY_DEF_PATTERN = /^(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const JS_DEF_PATTERN = /^(?:export\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/;

function definitionPatternFor(extension) {
  return extension === '.py' ? PY_DEF_PATTERN : JS_DEF_PATTERN;
}

function isFrameworkInvokedName(name, extension) {
  if (name === 'main') return true;
  if (/^__.+__$/.test(name)) return true;
  if (extension === '.py' && (/^test_/.test(name) || /^Test[A-Z_]/.test(name))) return true;
  return false;
}

function collectRefactorDeadSymbolCandidates(file) {
  const extension = path.extname(file.path);
  if (!DEFINITION_EXTENSIONS.has(extension) || file.category === 'test' || file.category === 'generated') {
    return [];
  }
  const pattern = definitionPatternFor(extension);
  const candidates = [];
  for (const lineNumber of file.addedLineNumbers) {
    const text = file.newContent.split('\n')[lineNumber - 1] ?? '';
    const match = pattern.exec(text);
    const name = match ? (match[1] || match[2]) : '';
    if (!name || isFrameworkInvokedName(name, extension)) continue;
    candidates.push({ name, path: file.path, line: lineNumber, source: file.source });
  }
  return candidates;
}

function collectRefactorFindings(files) {
  const candidates = files.flatMap((file) => collectRefactorDeadSymbolCandidates(file));
  if (candidates.length === 0) {
    return [];
  }
  const haystack = files.map((file) => file.newContent).join('\n');
  const findings = [];
  for (const candidate of candidates) {
    const occurrences = haystack.match(new RegExp(`\\b${candidate.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'));
    if (!occurrences || occurrences.length <= 1) {
      findings.push(makeFinding('refactor-dead-symbol', candidate.path, candidate.line, candidate.source));
    }
  }
  if (candidates.length > 1) {
    for (const candidate of candidates) {
      findings.push(makeFinding('refactor-multiple-symbols', candidate.path, candidate.line, candidate.source));
    }
  }
  return findings;
}

function makeFinding(kind, filePath, line, source) {
  const policy = POLICY[kind];
  return {
    kind,
    severity: policy.severity,
    message: policy.message,
    path: filePath,
    line: line ?? null,
    source: source ?? 'diff',
  };
}

export function collectDiffAtomicityFindings(options = {}) {
  const { diffText, source = 'diff', reviewLane } = options;
  const files = Array.isArray(options.files) ? options.files : parseUnifiedDiff(diffText, source);
  const findings = [];

  if (reviewLane === 'refactor') {
    findings.push(...collectRefactorFindings(files));
  }

  const hasGenerated = files.some((file) => file.category === 'generated');
  const hasHandwritten = files.some((file) => file.category === 'source' || file.category === 'test');
  if (hasGenerated && hasHandwritten) {
    for (const file of files) {
      if (file.category === 'generated') {
        findings.push(makeFinding('mixed-generated-and-source', file.path, null, file.source));
      }
    }
  }

  const lockfiles = files.filter((file) => file.category === 'lockfile');
  const hasManifest = files.some((file) => file.category === 'manifest');
  if (lockfiles.length > 0 && !hasManifest) {
    for (const file of lockfiles) {
      findings.push(makeFinding('orphaned-lockfile', file.path, null, file.source));
    }
  }

  for (const file of files) {
    findings.push(...collectAstFindings(file));
  }

  findings.push(...collectTestAssertionWeakenedFindings(files));

  const areas = new Set();
  for (const file of files) {
    if (['source', 'test', 'docs', 'config', 'other'].includes(file.category) && file.path && file.path !== '/dev/null') {
      areas.add(topArea(file.path));
    }
  }
  if (areas.size >= 3) {
    const finding = makeFinding('unrelated-areas', '', null, source);
    finding.message = `${finding.message} (${[...areas].sort().join(', ')})`;
    findings.push(finding);
  }

  return findings;
}

export function formatDiffAtomicityFindings(findings) {
  return findings.map((finding) => {
    const location = finding.path
      ? `${finding.path}${finding.line ? `:${finding.line}` : ''}`
      : '(diff)';
    return `${finding.kind} ${location} — ${finding.message}`;
  });
}

/** Full-context diffs scale with whole-file size, so they outgrow Node's 1MB default. */
const GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

function runGit(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function lintDiffAtomicityForGit(options = {}) {
  const root = options.root || process.cwd();
  const baseRef = options.baseRef;
  if (!baseRef) {
    throw new Error('lintDiffAtomicityForGit requires a baseRef');
  }
  const diffText = runGit(root, [
    'diff',
    '--find-renames',
    '--unified=200000',
    '--diff-filter=ACMRTD',
    `${baseRef}...HEAD`,
    '--',
  ]);
  return collectDiffAtomicityFindings({ diffText, source: `${baseRef}...HEAD`, reviewLane: options.reviewLane });
}

function usage() {
  console.error('Usage: node scripts/lint-pr-diff-atomicity.mjs [--base <ref>] [--root <path>] [--review-lane <lane>]');
}

function hasGitRef(root, ref) {
  try {
    runGit(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function defaultBase(root) {
  const candidates = [];
  if (process.env.GITHUB_BASE_REF) {
    candidates.push(`origin/${process.env.GITHUB_BASE_REF}`);
  }
  candidates.push('origin/master', 'origin/main', 'master', 'main');
  for (const candidate of candidates) {
    if (hasGitRef(root, candidate)) {
      return candidate;
    }
  }
  return '';
}

function parseArgs(argv) {
  const parsed = { base: process.env.INVOKER_DIFF_ATOMICITY_BASE || '', root: process.cwd(), reviewLane: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') {
      parsed.base = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--base=')) {
      parsed.base = arg.slice('--base='.length);
    } else if (arg === '--root') {
      parsed.root = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--root=')) {
      parsed.root = arg.slice('--root='.length);
    } else if (arg === '--review-lane') {
      parsed.reviewLane = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--review-lane=')) {
      parsed.reviewLane = arg.slice('--review-lane='.length);
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      console.error(`[atomicity] Unknown argument: ${arg}`);
      usage();
      process.exit(2);
    }
  }
  return { base: parsed.base, root: path.resolve(parsed.root), reviewLane: parsed.reviewLane };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base || defaultBase(args.root);
  if (!base) {
    console.error('[atomicity] Could not resolve a base ref. Pass --base <ref>.');
    process.exit(2);
  }

  const findings = lintDiffAtomicityForGit({ root: args.root, baseRef: base, reviewLane: args.reviewLane });
  const fatal = findings.filter((finding) => finding.severity === 'fatal');
  const warnings = findings.filter((finding) => finding.severity === 'warning');

  if (fatal.length > 0) {
    console.error('Diff atomicity validation failed:');
    for (const line of formatDiffAtomicityFindings(fatal)) {
      console.error(`  ${line}`);
    }
    for (const line of formatDiffAtomicityFindings(warnings)) {
      console.error(`  warning: ${line}`);
    }
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.error('Diff atomicity warnings:');
    for (const line of formatDiffAtomicityFindings(warnings)) {
      console.error(`  ${line}`);
    }
    process.exit(0);
  }

  console.log('Diff atomicity validation passed.');
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  main();
}
