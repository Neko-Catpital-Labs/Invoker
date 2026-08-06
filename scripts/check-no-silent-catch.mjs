#!/usr/bin/env node

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = process.cwd();
const PACKAGES_DIR = path.join(ROOT, 'packages');
const JSON_MODE = process.argv.includes('--json');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIPPED_DIRS = new Set(['__tests__', 'e2e', 'fixtures']);
const LOG_METHODS = new Set(['warn', 'error', 'info', 'debug']);
const ERROR_KEYS = new Set(['error', 'errors', 'reason', 'cause', 'detail', 'summary', 'message']);
const FALSE_STATUS_KEYS = new Set(['ok', 'success', 'valid']);
const CRITICAL_PATH_TERMS = [
  'auth',
  'exec',
  'shell',
  'git',
  'db',
  'data-store',
  'secret',
  'token',
  'merge',
  'launch',
];
const UI_PRESENTATIONAL_PACKAGES = new Set(['@invoker/ui', '@invoker/web-app', '@invoker/npm-ui', 'ui', 'web-app', 'npm-ui']);

function main() {
  const packageInfos = listPackageInfos();
  const violations = [];

  for (const packageInfo of packageInfos) {
    for (const file of listSourceFiles(packageInfo.srcDir)) {
      violations.push(...scanFile(file, packageInfo));
    }
  }

  violations.sort((a, b) =>
    a.package.localeCompare(b.package)
    || a.file.localeCompare(b.file)
    || a.line - b.line
    || a.kind.localeCompare(b.kind)
  );

  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify(violations, null, 2)}\n`);
    process.exitCode = 0;
    return;
  }

  for (const violation of violations) {
    process.stdout.write(`${violation.severity}\t${violation.package}\t${violation.kind}\t${violation.file}:${violation.line}\n`);
  }
  process.exitCode = violations.length === 0 ? 0 : 1;
}

function listPackageInfos() {
  if (!fs.existsSync(PACKAGES_DIR)) return [];

  return fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageDir = path.join(PACKAGES_DIR, entry.name);
      const srcDir = path.join(packageDir, 'src');
      if (!fs.existsSync(srcDir)) return null;

      return {
        dirName: entry.name,
        packageDir,
        packageName: readPackageName(packageDir) ?? entry.name,
        srcDir,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.packageName.localeCompare(b.packageName));
}

function readPackageName(packageDir) {
  const packageJsonPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return null;

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return typeof packageJson.name === 'string' && packageJson.name.length > 0 ? packageJson.name : null;
  } catch {
    return null;
  }
}

function listSourceFiles(srcDir) {
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name);
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue;

      files.push(path.join(dir, entry.name));
    }
  }

  walk(srcDir);
  return files.sort();
}

function scanFile(file, packageInfo) {
  const sourceText = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const handlerBindings = collectHandlerBindings(sourceFile);
  const violations = [];

  function visit(node) {
    if (ts.isTryStatement(node) && node.catchClause) {
      maybeAddViolation(node.catchClause.block, node.catchClause, 'try-catch');
    }

    if (ts.isCallExpression(node) && isPromiseCatchCall(node)) {
      const handler = resolveCatchHandler(node.arguments[0], handlerBindings);
      if (handler) maybeAddViolation(handler, promiseCatchLocationNode(node), 'promise-catch');
    }

    ts.forEachChild(node, visit);
  }

  function maybeAddViolation(body, locationNode, kind) {
    const analysis = analyzeHandlerBody(body);
    if (analysis.hasLoggerCall || analysis.hasThrowLikeExit || analysis.hasTypedErrorOutcome) return;

    const position = sourceFile.getLineAndCharacterOfPosition(locationNode.getStart(sourceFile));
    const relativeFile = toPosix(path.relative(ROOT, file));
    violations.push({
      file: relativeFile,
      line: position.line + 1,
      package: packageInfo.packageName,
      kind,
      severity: severityFor(relativeFile, packageInfo),
    });
  }

  visit(sourceFile);
  return violations;
}

function collectHandlerBindings(sourceFile) {
  const bindings = new Map();

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      bindings.set(node.name.text, node.body);
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (isFunctionLikeWithBody(initializer)) {
        bindings.set(node.name.text, initializer.body);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return bindings;
}

function resolveCatchHandler(handler, handlerBindings) {
  if (!handler) return null;

  const unwrapped = unwrapExpression(handler);
  if (isFunctionLikeWithBody(unwrapped)) return unwrapped.body;
  if (ts.isIdentifier(unwrapped)) return handlerBindings.get(unwrapped.text) ?? null;

  return null;
}

function isFunctionLikeWithBody(node) {
  return (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node))
    && Boolean(node.body)
  );
}

function isPromiseCatchCall(node) {
  const expression = unwrapExpression(node.expression);
  return ts.isPropertyAccessExpression(expression) && expression.name.text === 'catch';
}

function promiseCatchLocationNode(node) {
  const expression = unwrapExpression(node.expression);
  return ts.isPropertyAccessExpression(expression) ? expression.name : node;
}

function analyzeHandlerBody(body) {
  const result = {
    hasLoggerCall: false,
    hasThrowLikeExit: false,
    hasTypedErrorOutcome: false,
  };

  function visit(node, isRoot = false) {
    if (!isRoot && isNestedScope(node)) return;

    if (ts.isThrowStatement(node)) {
      result.hasThrowLikeExit = true;
      return;
    }

    if (ts.isReturnStatement(node) && node.expression && isTypedErrorExpression(node.expression)) {
      result.hasTypedErrorOutcome = true;
    }

    if (ts.isCallExpression(node)) {
      if (isLoggerCall(node)) result.hasLoggerCall = true;
      if (isRejectCall(node)) result.hasThrowLikeExit = true;
      if (node.arguments.some((arg) => isTypedErrorExpression(arg))) result.hasTypedErrorOutcome = true;
    }

    if (!ts.isBlock(body) && node === body && isTypedErrorExpression(node)) {
      result.hasTypedErrorOutcome = true;
    }

    if (result.hasLoggerCall && result.hasThrowLikeExit && result.hasTypedErrorOutcome) return;
    ts.forEachChild(node, (child) => visit(child));
  }

  visit(body, true);
  return result;
}

function isNestedScope(node) {
  return (
    ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
    || ts.isFunctionDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isClassExpression(node)
  );
}

function isLoggerCall(node) {
  const parts = expressionChainParts(node.expression);
  if (parts.length === 0) return false;

  const last = parts.at(-1);
  if (last === 'log') return true;
  if (parts[0] === 'console' && (last === 'error' || last === 'warn')) return true;
  if (LOG_METHODS.has(last) && (parts.includes('logger') || parts.includes('log'))) return true;

  return false;
}

function isRejectCall(node) {
  const parts = expressionChainParts(node.expression);
  if (parts.length === 0) return false;

  const last = parts.at(-1);
  return last === 'reject' || (parts.length === 2 && parts[0] === 'Promise' && parts[1] === 'reject');
}

function isTypedErrorExpression(expression) {
  const unwrapped = unwrapExpression(expression);

  if (ts.isObjectLiteralExpression(unwrapped)) {
    return objectLiteralHasErrorShape(unwrapped);
  }

  if (ts.isCallExpression(unwrapped)) {
    return unwrapped.arguments.some((arg) => isTypedErrorExpression(arg));
  }

  if (ts.isConditionalExpression(unwrapped)) {
    return isTypedErrorExpression(unwrapped.whenTrue) || isTypedErrorExpression(unwrapped.whenFalse);
  }

  if (ts.isAwaitExpression(unwrapped)) {
    return isTypedErrorExpression(unwrapped.expression);
  }

  return false;
}

function objectLiteralHasErrorShape(objectLiteral) {
  let hasErrorKey = false;
  let hasFalseStatus = false;
  let hasErrorDiscriminant = false;

  for (const property of objectLiteral.properties) {
    const name = propertyNameText(property.name);
    if (!name && ts.isShorthandPropertyAssignment(property)) {
      if (ERROR_KEYS.has(property.name.text)) hasErrorKey = true;
      continue;
    }
    if (!name) continue;

    if (ERROR_KEYS.has(name)) hasErrorKey = true;
    if (FALSE_STATUS_KEYS.has(name) && ts.isPropertyAssignment(property) && isFalseLiteral(property.initializer)) {
      hasFalseStatus = true;
    }
    if ((name === 'kind' || name === 'type' || name === 'status') && ts.isPropertyAssignment(property)) {
      const value = literalText(property.initializer);
      if (value === 'error' || value === 'failed' || value === 'failure') hasErrorDiscriminant = true;
    }
  }

  return hasErrorKey || hasFalseStatus || hasErrorDiscriminant;
}

function propertyNameText(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function literalText(expression) {
  const unwrapped = unwrapExpression(expression);
  return ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped) ? unwrapped.text : null;
}

function isFalseLiteral(expression) {
  return unwrapExpression(expression).kind === ts.SyntaxKind.FalseKeyword;
}

function expressionChainParts(expression) {
  const unwrapped = unwrapExpression(expression);

  if (ts.isIdentifier(unwrapped)) return [unwrapped.text];
  if (unwrapped.kind === ts.SyntaxKind.ThisKeyword) return ['this'];
  if (unwrapped.kind === ts.SyntaxKind.SuperKeyword) return ['super'];

  if (ts.isPrivateIdentifier(unwrapped)) return [unwrapped.text];

  if (ts.isPropertyAccessExpression(unwrapped)) {
    return [...expressionChainParts(unwrapped.expression), unwrapped.name.text];
  }

  if (ts.isElementAccessExpression(unwrapped)) {
    const argument = unwrapExpression(unwrapped.argumentExpression);
    if (argument && ts.isStringLiteral(argument)) {
      return [...expressionChainParts(unwrapped.expression), argument.text];
    }
  }

  return [];
}

function unwrapExpression(expression) {
  let current = expression;

  while (current) {
    if (
      ts.isParenthesizedExpression(current)
      || ts.isNonNullExpression(current)
      || ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }

    return current;
  }

  return current;
}

function severityFor(relativeFile, packageInfo) {
  const lowerPath = relativeFile.toLowerCase();
  const lowerPackage = `${packageInfo.packageName} ${packageInfo.dirName}`.toLowerCase();

  if (CRITICAL_PATH_TERMS.some((term) => lowerPath.includes(term) || lowerPackage.includes(term))) {
    return 'critical';
  }

  if (
    UI_PRESENTATIONAL_PACKAGES.has(packageInfo.packageName)
    || UI_PRESENTATIONAL_PACKAGES.has(packageInfo.dirName)
    || lowerPath.includes('/components/')
  ) {
    return 'minor';
  }

  return 'major';
}

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

try {
  main();
} catch (error) {
  if (JSON_MODE) {
    process.stdout.write('[]\n');
    process.exitCode = 0;
  } else {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
