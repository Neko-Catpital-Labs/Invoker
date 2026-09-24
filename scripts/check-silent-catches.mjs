#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const CHECKED_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const SKIPPED_PATH_PARTS = new Set(['.git', 'node_modules', 'dist', 'coverage', 'out']);

function usage() { console.error('Usage: node scripts/check-silent-catches.mjs [--base <ref>] [--root <path>] | --selftest'); }

function parseArgs(argv) {
  const parsed = { base: process.env.INVOKER_SILENT_CATCH_BASE || '', root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') { parsed.base = argv[index + 1] || ''; index += 1; }
    else if (arg.startsWith('--base=')) parsed.base = arg.slice('--base='.length);
    else if (arg === '--root') { parsed.root = argv[index + 1] || ''; index += 1; }
    else if (arg.startsWith('--root=')) parsed.root = arg.slice('--root='.length);
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else { console.error(`[silent-catches] Unknown argument: ${arg}`); usage(); process.exit(2); }
  }
  return { base: parsed.base, root: path.resolve(parsed.root) };
}

function runGit(root, args) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isCheckedFile(filePath) {
  const normalized = filePath.split(path.sep).join('/');
  if (!CHECKED_EXTENSIONS.has(path.extname(normalized))) return false;
  return !normalized.split('/').some((part) => SKIPPED_PATH_PARTS.has(part));
}

function scriptKindFor(filePath) {
  const extension = path.extname(filePath);
  if (extension === '.ts') return ts.ScriptKind.TS;
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function isSilentStatement(statement) {
  if (ts.isEmptyStatement(statement)) return true;
  if (ts.isBlock(statement)) return statement.statements.every(isSilentStatement);
  if (ts.isIfStatement(statement)) {
    return isSilentStatement(statement.thenStatement)
      && (!statement.elseStatement || isSilentStatement(statement.elseStatement));
  }
  return false;
}

export function findSilentCatchLines(filePath, content) {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
  const diagnostics = sourceFile.parseDiagnostics || [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const position = first.start === undefined ? '' : `${sourceFile.getLineAndCharacterOfPosition(first.start).line + 1}: `;
    return { status: 'unchecked', reason: `${position}${ts.flattenDiagnosticMessageText(first.messageText, ' ')}` };
  }
  const lines = [];
  const visit = (node) => {
    if (ts.isCatchClause(node) && isSilentStatement(node.block)) {
      lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { status: lines.length > 0 ? 'hit' : 'clean', lines };
}

function parseAddedLines(diffText) {
  const files = new Map();
  let currentPath = '';
  let checked = false;
  let newLine = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      currentPath = line.slice(4).trim().replace(/^b\//, '');
      checked = currentPath !== '/dev/null' && isCheckedFile(currentPath);
      continue;
    }
    if (line.startsWith('@@ ')) {
      const match = /\+(\d+)/.exec(line);
      newLine = match ? Number.parseInt(match[1], 10) : 0;
      continue;
    }
    if (!checked || newLine < 1) continue;
    const isAdded = line.startsWith('+') && !line.startsWith('+++');
    const isContext = line.startsWith(' ') || line === '';
    if (!isAdded && !isContext) continue;
    if (!files.has(currentPath)) files.set(currentPath, new Map());
    files.get(currentPath).set(newLine, { added: isAdded, text: line.slice(1) });
    newLine += 1;
  }
  return files;
}

function contentFromDiffLines(lineMap) {
  const lastLine = Math.max(0, ...lineMap.keys());
  const lines = [];
  for (let lineNumber = 1; lineNumber <= lastLine; lineNumber += 1) lines.push(lineMap.get(lineNumber)?.text ?? '');
  return lines.join('\n');
}

export function evaluateAddedSilentCatches(diffText, source = 'diff', readContent = null) {
  const violations = [];
  const unchecked = [];
  for (const [filePath, lineMap] of parseAddedLines(diffText)) {
    const addedLines = [...lineMap].filter(([, entry]) => entry.added).map(([lineNumber]) => lineNumber);
    if (addedLines.length === 0) continue;
    let content;
    try {
      content = readContent ? readContent(filePath) : contentFromDiffLines(lineMap);
    } catch (error) {
      unchecked.push({ source, path: filePath, reason: `could not read file: ${error.message.split('\n')[0]}` });
      continue;
    }
    const result = findSilentCatchLines(filePath, content);
    if (result.status === 'unchecked') {
      unchecked.push({ source, path: filePath, reason: result.reason });
      continue;
    }
    const added = new Set(addedLines);
    const contentLines = content.split('\n');
    for (const lineNumber of result.lines) {
      if (added.has(lineNumber)) {
        violations.push({ source, path: filePath, line: lineNumber, text: (contentLines[lineNumber - 1] || '').trim() });
      }
    }
  }
  return { violations, unchecked };
}

export function collectAddedSilentCatchViolations(diffText, source = 'diff', readContent = null) {
  const { violations, unchecked } = evaluateAddedSilentCatches(diffText, source, readContent);
  if (unchecked.length > 0) {
    throw new Error(`[silent-catches] Unchecked (could not parse): ${unchecked.map((entry) => entry.path).join(', ')}`);
  }
  return violations;
}

function defaultBase(root) {
  for (const candidate of ['origin/master', 'origin/main']) {
    try { runGit(root, ['merge-base', candidate, 'HEAD']); return candidate; }
    catch { /* Try the next conventional base ref. */ }
  }
  return '';
}

function contentReaders(root) {
  const topLevel = runGit(root, ['rev-parse', '--show-toplevel']).trim();
  return {
    head: (filePath) => runGit(topLevel, ['show', `HEAD:${filePath}`]),
    staged: (filePath) => runGit(topLevel, ['show', `:${filePath}`]),
    workingTree: (filePath) => readFileSync(path.join(topLevel, filePath), 'utf8'),
  };
}

function runGate(args) {
  const base = args.base || defaultBase(args.root);
  const readers = contentReaders(args.root);
  const sources = [];
  if (base) sources.push({ name: `${base}...HEAD`, read: readers.head, text: runGit(args.root, ['diff', '--unified=0', '--diff-filter=ACMRT', `${base}...HEAD`, '--']) });
  sources.push({ name: 'staged changes', read: readers.staged, text: runGit(args.root, ['diff', '--cached', '--unified=0', '--diff-filter=ACMRT', '--']) });
  sources.push({ name: 'working tree changes', read: readers.workingTree, text: runGit(args.root, ['diff', '--unified=0', '--diff-filter=ACMRT', '--']) });
  const results = sources.map((source) => evaluateAddedSilentCatches(source.text, source.name, source.read));
  const violations = results.flatMap((result) => result.violations);
  const unchecked = results.flatMap((result) => result.unchecked);
  if (violations.length > 0) {
    console.error(`[silent-catches] Found ${violations.length} newly-added empty catch block(s).`);
    console.error('[silent-catches] Handle, rethrow, or explicitly report every caught error.');
    for (const violation of violations) console.error(`[silent-catches] ${violation.path}:${violation.line} (${violation.source}) ${violation.text}`);
  }
  if (unchecked.length > 0) {
    console.error(`[silent-catches] Unchecked ${unchecked.length} file(s): could not parse, so they are NOT verified clean.`);
    for (const entry of unchecked) console.error(`[silent-catches] unchecked ${entry.path} (${entry.source}) ${entry.reason}`);
  }
  if (violations.length > 0) return 1;
  if (unchecked.length > 0) return 3;
  console.log('[silent-catches] Parsed changed source files; no newly-added empty catch blocks found.');
  return 0;
}

function runSelfSample(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'silent-catches-selftest-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
    execFileSync('git', ['add', '--', ...Object.keys(files)], { cwd: dir });
    const env = { ...process.env };
    delete env.INVOKER_SILENT_CATCH_BASE;
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--root', dir], { encoding: 'utf8', env });
    return { status: child.status, output: `${child.stdout}${child.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function selftest() {
  const failures = [];
  const hits = runSelfSample({
    'sample.mjs': 'try { a(); } catch { }\ntry { b(); } catch (e) { if (Date.now() > 0) { } }\ntry {\n  c();\n} catch (e) {\n  // nothing\n}\ntry { d(); } catch (e) { report(e); }\n',
  });
  process.stdout.write(hits.output);
  if (hits.status !== 1 || !hits.output.includes('Found 3 newly-added empty catch block(s)')) {
    failures.push(`expected three-case sample to report "Found 3" with exit 1, got exit ${hits.status}`);
  }
  const twoCase = runSelfSample({ 'two.mjs': 'try { a(); } catch { }\ntry { b(); } catch (e) { if (Date.now() > 0) { } }\n' });
  process.stdout.write(twoCase.output);
  if (twoCase.status !== 1 || !twoCase.output.includes('Found 2 newly-added empty catch block(s)')) {
    failures.push(`expected two-case sample to report "Found 2" with exit 1, got exit ${twoCase.status}`);
  }
  const broken = runSelfSample({ 'broken.mjs': 'try { a( } catch {\n' });
  process.stdout.write(broken.output);
  if (broken.status === 0 || !broken.output.includes('unchecked broken.mjs')) {
    failures.push(`expected unparseable sample to report unchecked broken.mjs with non-zero exit, got exit ${broken.status}`);
  }
  for (const failure of failures) console.error(`[silent-catches] selftest FAILED: ${failure}`);
  if (failures.length > 0) return 1;
  console.log('[silent-catches] selftest passed');
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());
  process.exit(runGate(parseArgs(argv)));
}

if (path.resolve(process.argv[1] || '') === path.resolve(new URL(import.meta.url).pathname)) main();
