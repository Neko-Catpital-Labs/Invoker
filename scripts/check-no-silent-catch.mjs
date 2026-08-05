#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const CHECKED_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIPPED_DIRS = new Set(['__tests__', 'e2e', 'fixtures']);
const SKIPPED_FILE_PARTS = [/\.test\./, /\.spec\./];
const LOG_METHODS = new Set(['debug', 'error', 'info', 'warn']);
const CRITICAL_PATH_RE = /(^|[/-])(auth|exec|execution|shell|git|db|data-store|secret|token|merge|launch)([/-]|$|\b)/i;
const UI_PACKAGES = new Set(['ui', 'web-app']);

function usage() {
  console.error('Usage: node scripts/check-no-silent-catch.mjs [--json] [--root <path>]');
}

function parseArgs(argv) {
  const wantsJson = argv.includes('--json');
  const parsed = {
    json: false,
    root: process.cwd(),
  };

  function fail(message) {
    if (wantsJson) {
      process.stdout.write('[]\n');
      process.stderr.write(`${message}\n`);
      process.exit(0);
    }

    console.error(message);
    usage();
    process.exit(2);
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--root') {
      parsed.root = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--root=')) {
      parsed.root = arg.slice('--root='.length);
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      fail(`[silent-catch] Unknown argument: ${arg}`);
    }
  }

  if (!parsed.root) {
    fail('[silent-catch] Missing --root value');
  }

  return {
    json: parsed.json,
    root: path.resolve(parsed.root),
  };
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function packageNameForFile(relativeFile) {
  const parts = relativeFile.split('/');
  return parts[0] === 'packages' && parts[1] ? parts[1] : '';
}

function severityForFile(relativeFile, packageName) {
  if (CRITICAL_PATH_RE.test(relativeFile)) {
    return 'critical';
  }
  if (UI_PACKAGES.has(packageName)) {
    return 'minor';
  }
  return 'major';
}

function shouldSkipFile(relativeFile) {
  const normalized = toPosixPath(relativeFile);
  const parts = normalized.split('/');
  const basename = parts[parts.length - 1] || '';
  const extension = path.extname(basename);

  if (!CHECKED_EXTENSIONS.has(extension) || basename.endsWith('.d.ts')) {
    return true;
  }
  if (SKIPPED_FILE_PARTS.some((pattern) => pattern.test(basename))) {
    return true;
  }
  return parts.some((part) => SKIPPED_DIRS.has(part));
}

async function collectSourceFiles(root) {
  const packagesDir = path.join(root, 'packages');
  const files = [];
  let packageEntries = [];

  try {
    packageEntries = await readdir(packagesDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return files;
    }
    throw error;
  }

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const absolute = path.join(dir, entry.name);
      const relative = toPosixPath(path.relative(root, absolute));

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) {
          await walk(absolute);
        }
        return;
      }

      if (entry.isFile() && !shouldSkipFile(relative)) {
        files.push(relative);
      }
    }));
  }

  await Promise.all(packageEntries.map(async (entry) => {
    if (!entry.isDirectory()) {
      return;
    }
    const srcDir = path.join(packagesDir, entry.name, 'src');
    try {
      await walk(srcDir);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }));

  return files.sort();
}

function isFunctionLikeNode(node) {
  return ts.isArrowFunction(node)
    || ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node);
}

function findInNode(root, predicate) {
  let found = false;

  function visit(node) {
    if (found) {
      return;
    }
    if (node !== root && (isFunctionLikeNode(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
      return;
    }
    if (predicate(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(root);
  return found;
}

function propertyChain(expression) {
  if (ts.isIdentifier(expression)) {
    return [expression.text];
  }
  if (ts.isThis(expression)) {
    return ['this'];
  }
  if (expression.kind === ts.SyntaxKind.SuperKeyword) {
    return ['super'];
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return [...propertyChain(expression.expression), expression.name.text];
  }
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
    return [...propertyChain(expression.expression), expression.argumentExpression.text];
  }
  return [];
}

function isLoggerCall(node) {
  if (!ts.isCallExpression(node)) {
    return false;
  }

  const chain = propertyChain(node.expression);
  if (chain.length === 0) {
    return false;
  }

  const last = chain[chain.length - 1];
  const previous = chain[chain.length - 2];

  if (last === 'log') {
    return true;
  }
  if (previous === 'console' && (last === 'error' || last === 'warn')) {
    return true;
  }
  if ((previous === 'logger' || previous === 'log' || chain.includes('logger')) && LOG_METHODS.has(last)) {
    return true;
  }
  return false;
}

function unwrapExpression(expression) {
  let current = expression;
  while (true) {
    if (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function propertyNameText(name) {
  if (!name) {
    return '';
  }
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return '';
}

function isFalseLiteral(expression) {
  const unwrapped = unwrapExpression(expression);
  return unwrapped.kind === ts.SyntaxKind.FalseKeyword;
}

function stringLiteralValue(expression) {
  const unwrapped = unwrapExpression(expression);
  return ts.isStringLiteralLike(unwrapped) ? unwrapped.text : '';
}

function objectLiteralHasErrorShape(expression) {
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      continue;
    }

    if (ts.isShorthandPropertyAssignment(property)) {
      const name = property.name.text;
      if (name === 'error' || name === 'errors' || name === 'err') {
        return true;
      }
      continue;
    }

    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    const name = propertyNameText(property.name);
    if (name === 'error' || name === 'errors' || name === 'err') {
      return true;
    }
    if ((name === 'ok' || name === 'success' || name === 'valid') && isFalseLiteral(property.initializer)) {
      return true;
    }

    const literal = stringLiteralValue(property.initializer);
    if ((name === 'kind' || name === 'type' || name === 'state' || name === 'status') && /^(error|failed|failure|fail)$/.test(literal)) {
      return true;
    }
    if ((name === 'reason' || name === 'message') && literal.length > 0) {
      return true;
    }
  }

  return false;
}

function expressionReferencesCaughtError(expression, caughtName) {
  if (!caughtName) {
    return false;
  }
  return findInNode(expression, (node) => ts.isIdentifier(node) && node.text === caughtName);
}

function isTypedErrorReturnExpression(expression, caughtName) {
  const unwrapped = unwrapExpression(expression);

  if (ts.isObjectLiteralExpression(unwrapped)) {
    return objectLiteralHasErrorShape(unwrapped);
  }
  if (ts.isNewExpression(unwrapped) && propertyChain(unwrapped.expression).at(-1) === 'Error') {
    return true;
  }
  if (ts.isIdentifier(unwrapped) && (unwrapped.text === 'error' || unwrapped.text === 'err' || unwrapped.text === caughtName)) {
    return true;
  }
  if (ts.isCallExpression(unwrapped) && propertyChain(unwrapped.expression).join('.') === 'Promise.reject') {
    return true;
  }
  if (ts.isConditionalExpression(unwrapped)) {
    return isTypedErrorReturnExpression(unwrapped.whenTrue, caughtName)
      && isTypedErrorReturnExpression(unwrapped.whenFalse, caughtName);
  }
  if (ts.isCallExpression(unwrapped) && /error|err|fail/i.test(propertyChain(unwrapped.expression).join('.')) && expressionReferencesCaughtError(unwrapped, caughtName)) {
    return true;
  }

  return false;
}

function hasTypedErrorReturn(body, caughtName) {
  if (!ts.isBlock(body)) {
    return isTypedErrorReturnExpression(body, caughtName);
  }

  return findInNode(body, (node) => ts.isReturnStatement(node)
    && node.expression !== undefined
    && isTypedErrorReturnExpression(node.expression, caughtName));
}

function catchVariableName(catchClause) {
  const declaration = catchClause.variableDeclaration;
  if (!declaration || !ts.isIdentifier(declaration.name)) {
    return '';
  }
  return declaration.name.text;
}

function handlerParameterName(handler) {
  if ((ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) && handler.parameters.length > 0) {
    const first = handler.parameters[0].name;
    if (ts.isIdentifier(first)) {
      return first.text;
    }
  }
  return '';
}

function isSilentHandlerBody(body, caughtName) {
  return !findInNode(body, isLoggerCall)
    && !findInNode(body, (node) => ts.isThrowStatement(node))
    && !hasTypedErrorReturn(body, caughtName);
}

function promiseCatchHandler(argument) {
  if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
    return {
      body: argument.body,
      caughtName: handlerParameterName(argument),
      lineNode: argument,
    };
  }
  return null;
}

function collectViolations(sourceFile, relativeFile) {
  const violations = [];
  const packageName = packageNameForFile(relativeFile);
  const severity = severityForFile(relativeFile, packageName);

  function pushViolation(lineNode, kind) {
    const line = sourceFile.getLineAndCharacterOfPosition(lineNode.getStart(sourceFile)).line + 1;
    violations.push({
      file: relativeFile,
      line,
      package: packageName,
      kind,
      severity,
    });
  }

  function visit(node) {
    if (ts.isTryStatement(node) && node.catchClause) {
      const caughtName = catchVariableName(node.catchClause);
      if (isSilentHandlerBody(node.catchClause.block, caughtName)) {
        pushViolation(node.catchClause, 'try-catch');
      }
    }

    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'catch'
      && node.arguments.length > 0
    ) {
      const handler = promiseCatchHandler(node.arguments[0]);
      if (handler && isSilentHandlerBody(handler.body, handler.caughtName)) {
        pushViolation(handler.lineNode, 'promise-catch');
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = await collectSourceFiles(options.root);
  const violations = [];

  for (const relativeFile of files) {
    const absoluteFile = path.join(options.root, relativeFile);
    const sourceText = await readFile(absoluteFile, 'utf8');
    const scriptKind = relativeFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(relativeFile, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
    violations.push(...collectViolations(sourceFile, relativeFile));
  }

  violations.sort((left, right) => left.package.localeCompare(right.package)
    || left.file.localeCompare(right.file)
    || left.line - right.line
    || left.kind.localeCompare(right.kind));

  process.stdout.write(`${JSON.stringify(violations, null, 2)}\n`);
}

main().catch((error) => {
  if (process.argv.includes('--json')) {
    process.stdout.write('[]\n');
    process.stderr.write(`[silent-catch] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(0);
  }

  process.stderr.write(`[silent-catch] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
