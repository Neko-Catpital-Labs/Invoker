#!/usr/bin/env node
// Render a plan-to-invoker formula (recipe) into concrete Invoker plan YAML.
//
// A formula locks the workflow *shape* (which workflows exist, task structure,
// dependency edges, merge gates, and the required review/rationale headings).
// {{var}} slots carry short scalar inputs; REPLACE_ME markers left in the
// rendered plan flag prose the author is expected to specialize. This script
// only substitutes {{var}} slots — the reserved stack-wiring token
// __UPSTREAM_WORKFLOW_ID__ is intentionally left untouched for
// submit-workflow-chain.sh to fill.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../..');

function resolveYamlModulePath(scriptDir) {
  const localYamlPath = resolve(scriptDir, '../../..', 'packages/app/node_modules/yaml/dist/index.js');
  if (existsSync(localYamlPath)) return localYamlPath;
  return 'yaml';
}
const { parse: parseYaml } = await import(resolveYamlModulePath(__dirname));

function die(msg) {
  console.error(`render-formula: ${msg}`);
  process.exit(1);
}

function usage() {
  console.error(
    [
      'Usage: node render-formula.mjs <formula|path/to/formula.yaml> [--var k=v]... [--out DIR] [--example] [--print]',
      '',
      "Renders a formula's workflow templates into concrete plan YAML by",
      'substituting {{var}} slots. Required vars must be supplied via --var',
      'unless --example is set (which fills unset vars from each declared example).',
    ].join('\n'),
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') usage();

let formulaArg = '';
const varOverrides = {};
let outDir = join(REPO_ROOT, 'plans', 'rendered');
let useExample = false;
let printPaths = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--var') {
    const kv = argv[++i];
    if (!kv || !kv.includes('=')) die(`--var expects k=v, got "${kv ?? ''}"`);
    const eq = kv.indexOf('=');
    varOverrides[kv.slice(0, eq).trim()] = kv.slice(eq + 1);
  } else if (a === '--out') {
    const d = argv[++i];
    if (!d) die('--out expects a directory');
    outDir = resolve(d);
  } else if (a === '--example') {
    useExample = true;
  } else if (a === '--print') {
    printPaths = true;
  } else if (a.startsWith('--')) {
    die(`unknown flag ${a}`);
  } else if (!formulaArg) {
    formulaArg = a;
  } else {
    die(`unexpected argument "${a}"`);
  }
}
if (!formulaArg) usage();

let manifestPath;
if (formulaArg.endsWith('.yaml') || formulaArg.includes('/')) {
  manifestPath = resolve(formulaArg);
} else {
  manifestPath = join(REPO_ROOT, 'skills/plan-to-invoker/formulas', formulaArg, 'formula.yaml');
}
if (!existsSync(manifestPath)) die(`formula manifest not found: ${manifestPath}`);

const manifest = parseYaml(readFileSync(manifestPath, 'utf8'));
if (!manifest || typeof manifest !== 'object') die('manifest is not a YAML object');
const formulaName = typeof manifest.formula === 'string' ? manifest.formula : basename(dirname(manifestPath));
const formulaDir = dirname(manifestPath);
const varSpecs = manifest.vars && typeof manifest.vars === 'object' ? manifest.vars : {};
const workflows = Array.isArray(manifest.workflows) ? manifest.workflows : [];
if (workflows.length === 0) die('manifest declares no workflows');

for (const key of Object.keys(varOverrides)) {
  if (!(key in varSpecs)) die(`unknown --var "${key}" (not declared in ${basename(manifestPath)})`);
}

const values = {};
const missing = [];
for (const [name, spec] of Object.entries(varSpecs)) {
  if (name in varOverrides) {
    values[name] = varOverrides[name];
  } else if (spec && spec.default !== undefined) {
    values[name] = String(spec.default);
  } else if (useExample && spec && spec.example !== undefined) {
    values[name] = String(spec.example);
  } else if (spec && spec.required) {
    missing.push(name);
  }
}
if (missing.length) die(`missing required --var: ${missing.join(', ')} (or pass --example)`);

function substitute(text, file) {
  const unresolved = new Set();
  const out = text.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (m, key) => {
    if (key in values) return values[key];
    unresolved.add(key);
    return m;
  });
  if (unresolved.size) {
    die(`${file}: unresolved slot(s): {{${[...unresolved].join('}}, {{')}}} — declare them in manifest vars or pass --var`);
  }
  const stray = out.match(/\{\{[^}]*\}\}/);
  if (stray) die(`${file}: malformed template token "${stray[0]}"`);
  return out;
}

mkdirSync(outDir, { recursive: true });
const rendered = [];
for (const wf of workflows) {
  const tplPath = isAbsolute(wf) ? wf : join(formulaDir, wf);
  if (!existsSync(tplPath)) die(`workflow template not found: ${tplPath}`);
  const base = basename(tplPath);
  const outName = base.endsWith('.workflow.yaml') ? `${base.slice(0, -'.workflow.yaml'.length)}.yaml` : base;
  const outPath = join(outDir, outName);
  writeFileSync(outPath, substitute(readFileSync(tplPath, 'utf8'), base));
  rendered.push(outPath);
}

if (printPaths) {
  for (const p of rendered) console.log(p);
} else {
  console.error(`Rendered ${rendered.length} plan(s) from formula "${formulaName}" to ${outDir}:`);
  for (const p of rendered) console.error(`  ${p}`);
}
