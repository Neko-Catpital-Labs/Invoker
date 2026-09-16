#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const CHECKED_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const EXCLUDED_PACKAGES = new Set(['cli']);
const SKIPPED_PATH_PARTS = new Set(['__tests__', 'e2e', 'node_modules', 'dist']);
const CHILD_PROCESS_MODULES = new Set(['node:child_process', 'child_process']);
const SYNC_SPAWN_NAMES = new Set(['spawnSync', 'execFileSync', 'execSync']);
const BASE_CANDIDATES = ['origin/master', 'origin/main'];
const GIT_TIMEOUT_MS = 60_000;
const MAX_CONST_DEPTH = 10;

let typescriptModule;

function getTypeScript() {
  if (!typescriptModule) typescriptModule = require('typescript');
  return typescriptModule;
}

function usage() { console.error('Usage: node scripts/check-sync-spawn-timeouts.mjs [--base <ref>] [--root <path>]'); }

function parseArgs(argv) {
  const parsed = { base: process.env.INVOKER_SYNC_SPAWN_BASE || '', root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') { parsed.base = argv[index + 1] || ''; index += 1; }
    else if (arg.startsWith('--base=')) parsed.base = arg.slice('--base='.length);
    else if (arg === '--root') { parsed.root = argv[index + 1] || ''; index += 1; }
    else if (arg.startsWith('--root=')) parsed.root = arg.slice('--root='.length);
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else { console.error(`[sync-spawn-timeouts] Unknown argument: ${arg}`); usage(); process.exit(2); }
  }
  return { base: parsed.base, root: path.resolve(parsed.root) };
}

function runGit(root, args) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function isCheckedPath(filePath) {
  const parts = filePath.split(path.sep).join('/').split('/');
  if (parts.length < 4 || parts[0] !== 'packages' || parts[2] !== 'src' || EXCLUDED_PACKAGES.has(parts[1])) return false;
  if (!CHECKED_EXTENSIONS.has(path.extname(filePath))) return false;
  if (parts.some((part) => SKIPPED_PATH_PARTS.has(part))) return false;
  return !/\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath);
}

export function resolveBase({ explicitBase, refExists }) {
  if (explicitBase) return { base: explicitBase };
  for (const candidate of BASE_CANDIDATES) {
    if (refExists(candidate)) return { base: candidate };
  }
  return {
    unchecked: `no base ref found (tried ${BASE_CANDIDATES.join(', ')}); pass --base <ref> or set INVOKER_SYNC_SPAWN_BASE`,
  };
}

function addedLinesByPath(diffText) {
  const added = new Map();
  let currentPath = '';
  let checked = false;
  let newLine = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      currentPath = line.slice(4).trim().replace(/^b[/]/, '');
      checked = currentPath !== '/dev/null' && isCheckedPath(currentPath);
      continue;
    }
    if (line.startsWith('@@ ')) {
      const match = /\+(\d+)/.exec(line);
      newLine = match ? Number.parseInt(match[1], 10) : 0;
      continue;
    }
    if (!checked || newLine < 1) continue;
    if (line.startsWith('+')) {
      if (!added.has(currentPath)) added.set(currentPath, new Set());
      added.get(currentPath).add(newLine);
      newLine += 1;
    } else if (line.startsWith(' ')) {
      newLine += 1;
    }
  }
  return added;
}

function scriptKindFor(ts, filePath) {
  const extension = path.extname(filePath);
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.ts') return ts.ScriptKind.TS;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function isChildProcessRequire(ts, node) {
  return Boolean(node)
    && ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'require'
    && node.arguments.length === 1
    && ts.isStringLiteralLike(node.arguments[0])
    && CHILD_PROCESS_MODULES.has(node.arguments[0].text);
}

function collectBindings(ts, sourceFile) {
  const direct = new Map();
  const namespaces = new Set();
  const consts = new Map();

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && CHILD_PROCESS_MODULES.has(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name) namespaces.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) namespaces.add(clause.namedBindings.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (SYNC_SPAWN_NAMES.has(imported)) direct.set(element.name.text, imported);
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)
      && CHILD_PROCESS_MODULES.has(node.moduleReference.expression.text)) {
      namespaces.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node)) {
      if (isChildProcessRequire(ts, node.initializer)) {
        if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const property = element.propertyName ?? element.name;
            if (ts.isIdentifier(property) && ts.isIdentifier(element.name) && SYNC_SPAWN_NAMES.has(property.text)) {
              direct.set(element.name.text, property.text);
            }
          }
        }
      } else if (ts.isIdentifier(node.name) && node.initializer
        && ts.isVariableDeclarationList(node.parent)
        && (node.parent.flags & ts.NodeFlags.Const) !== 0) {
        consts.set(node.name.text, node.initializer);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { direct, namespaces, consts };
}

function syncSpawnApi(ts, call, bindings) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return bindings.direct.get(callee.text);
  if (ts.isPropertyAccessExpression(callee)
    && ts.isIdentifier(callee.expression)
    && bindings.namespaces.has(callee.expression.text)
    && SYNC_SPAWN_NAMES.has(callee.name.text)) {
    return callee.name.text;
  }
  return undefined;
}

function optionsArgument(ts, api, args) {
  if (api === 'execSync') return args[1];
  if (args.length >= 3) return args[2];
  if (args.length === 2 && ts.isObjectLiteralExpression(args[1])) return args[1];
  return undefined;
}

function staticNumber(ts, expression, consts, depth = 0) {
  if (!expression || depth > MAX_CONST_DEPTH) return undefined;
  if (ts.isNumericLiteral(expression)) return Number(expression.text.replaceAll('_', ''));
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return staticNumber(ts, expression.expression, consts, depth + 1);
  }
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken) {
    const value = staticNumber(ts, expression.operand, consts, depth + 1);
    return value === undefined ? undefined : -value;
  }
  if (ts.isBinaryExpression(expression)) {
    const left = staticNumber(ts, expression.left, consts, depth + 1);
    const right = staticNumber(ts, expression.right, consts, depth + 1);
    if (left === undefined || right === undefined) return undefined;
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken: return left + right;
      case ts.SyntaxKind.MinusToken: return left - right;
      case ts.SyntaxKind.AsteriskToken: return left * right;
      case ts.SyntaxKind.SlashToken: return left / right;
      default: return undefined;
    }
  }
  if (ts.isIdentifier(expression) && consts.has(expression.text)) {
    return staticNumber(ts, consts.get(expression.text), consts, depth + 1);
  }
  return undefined;
}

function timeoutProblem(ts, options, consts) {
  if (!options) return 'no options argument with a timeout';
  if (!ts.isObjectLiteralExpression(options)) return 'options are not an inline object literal, so the timeout cannot be proven';
  let timeoutValue;
  let hasSpread = false;
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) hasSpread = true;
    if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'timeout') {
      timeoutValue = property.initializer;
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'timeout') timeoutValue = property.name;
  }
  if (!timeoutValue) return hasSpread ? 'options spread cannot prove a timeout' : 'no timeout option';
  const value = staticNumber(ts, timeoutValue, consts);
  if (value === undefined) return 'timeout is not a statically known number';
  if (!Number.isFinite(value) || value <= 0) return `timeout must be a positive number (got ${value})`;
  return undefined;
}

export function collectUnboundedSyncSpawns(diffText, readPostImage, source = 'diff') {
  const violations = [];
  for (const [filePath, addedLines] of addedLinesByPath(diffText)) {
    let text;
    try {
      text = readPostImage(filePath);
    } catch (error) {
      violations.push({
        source, path: filePath, line: Math.min(...addedLines), text: '',
        reason: `unchecked: could not read post-image (${error instanceof Error ? error.message : String(error)})`,
      });
      continue;
    }
    const ts = getTypeScript();
    const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindFor(ts, filePath));
    const bindings = collectBindings(ts, sourceFile);
    if (bindings.direct.size === 0 && bindings.namespaces.size === 0) continue;

    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const api = syncSpawnApi(ts, node, bindings);
        if (api) {
          const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
          let touched = false;
          for (let line = startLine; line <= endLine; line += 1) {
            if (addedLines.has(line)) { touched = true; break; }
          }
          const problem = touched ? timeoutProblem(ts, optionsArgument(ts, api, node.arguments), bindings.consts) : undefined;
          if (problem) {
            violations.push({
              source, path: filePath, line: startLine,
              text: node.getText(sourceFile).split('\n')[0].trim().slice(0, 160),
              reason: problem,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolved = resolveBase({
    explicitBase: args.base,
    refExists: (ref) => spawnSync('git', ['merge-base', ref, 'HEAD'], { cwd: args.root, stdio: 'ignore', timeout: GIT_TIMEOUT_MS }).status === 0,
  });
  if (resolved.unchecked) {
    console.error(`[sync-spawn-timeouts] unchecked: ${resolved.unchecked}`);
    process.exit(1);
  }
  const sources = [
    {
      name: `${resolved.base}...HEAD`,
      text: runGit(args.root, ['diff', '--unified=0', '--diff-filter=ACMRT', `${resolved.base}...HEAD`, '--']),
      read: (filePath) => runGit(args.root, ['show', `HEAD:${filePath}`]),
    },
    {
      name: 'staged changes',
      text: runGit(args.root, ['diff', '--cached', '--unified=0', '--diff-filter=ACMRT', '--']),
      read: (filePath) => runGit(args.root, ['show', `:${filePath}`]),
    },
    {
      name: 'working tree changes',
      text: runGit(args.root, ['diff', '--unified=0', '--diff-filter=ACMRT', '--']),
      read: (filePath) => readFileSync(path.join(args.root, filePath), 'utf8'),
    },
  ];
  const violations = sources.flatMap((source) => collectUnboundedSyncSpawns(source.text, source.read, source.name));
  if (violations.length > 0) {
    console.error(`[sync-spawn-timeouts] Found ${violations.length} added or changed synchronous child_process call(s) without a provable positive timeout.`);
    console.error('[sync-spawn-timeouts] A blocking spawn with no timeout can freeze the whole Invoker process. Pass an inline positive timeout, or use an async spawn.');
    for (const violation of violations) {
      console.error(`[sync-spawn-timeouts] ${violation.path}:${violation.line} (${violation.source}, ${violation.reason}) ${violation.text}`);
    }
    process.exit(1);
  }
  console.log(`[sync-spawn-timeouts] Checked added lines against ${resolved.base}; every synchronous child_process call has a provable positive timeout.`);
}

if (path.resolve(process.argv[1] || '') === path.resolve(new URL(import.meta.url).pathname)) main();
