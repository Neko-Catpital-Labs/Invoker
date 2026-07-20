#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const CODE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
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
  'unrelated-areas': {
    severity: 'warning',
    message: 'The diff spans multiple unrelated top-level areas; confirm this is one atomic change.',
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

function scriptKindFor(filePath) {
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
  file.category = classifyPath(file.path);
  delete file.newLineMap;
  return file;
}

export function parseUnifiedDiff(diffText, source = 'diff') {
  const files = [];
  const lines = (diffText || '').split('\n');
  let current = null;
  let counter = 0;

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
      removedCount: 0,
      newLineMap: new Map(),
      newContent: '',
      category: 'other',
    };
    counter = 0;
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
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      counter = match ? Number.parseInt(match[1], 10) : 0;
      continue;
    }
    if (counter < 1) {
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.newLineMap.set(counter, line.slice(1));
      current.addedLineNumbers.add(counter);
      counter += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.removedCount += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      current.newLineMap.set(counter, line.slice(1));
      counter += 1;
    }
  }

  const finalized = finalizeFile(current);
  if (finalized) {
    files.push(finalized);
  }

  return files;
}

function rootIdentifier(node) {
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
  const findings = [];
  const sourceFile = ts.createSourceFile(file.path, file.newContent, ts.ScriptTarget.Latest, true, scriptKindFor(file.path));

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
      if ((member === 'only' || member === 'skip') && TEST_FUNCTIONS.has(rootIdentifier(node.expression))) {
        record(member === 'only' ? 'focused-test' : 'skipped-test', node);
      }
    }
    ts.forEachChild(node, walk);
  };

  walk(sourceFile);
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
  const { diffText, source = 'diff' } = options;
  const files = Array.isArray(options.files) ? options.files : parseUnifiedDiff(diffText, source);
  const findings = [];

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
  return collectDiffAtomicityFindings({ diffText, source: `${baseRef}...HEAD` });
}

function usage() {
  console.error('Usage: node scripts/lint-pr-diff-atomicity.mjs [--base <ref>] [--root <path>]');
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
  const parsed = { base: process.env.INVOKER_DIFF_ATOMICITY_BASE || '', root: process.cwd() };
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
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      console.error(`[atomicity] Unknown argument: ${arg}`);
      usage();
      process.exit(2);
    }
  }
  return { base: parsed.base, root: path.resolve(parsed.root) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base || defaultBase(args.root);
  if (!base) {
    console.error('[atomicity] Could not resolve a base ref. Pass --base <ref>.');
    process.exit(2);
  }

  const findings = lintDiffAtomicityForGit({ root: args.root, baseRef: base });
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
