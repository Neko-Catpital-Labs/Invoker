import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseSimpleYaml(block) {
  const out = {};
  let currentKey = null;
  let currentList = null;
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (!currentList) {
        currentList = [];
        out[currentKey] = currentList;
      }
      currentList.push(stripQuotes(listMatch[1].trim()));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      currentList = null;
      const value = kv[2].trim();
      if (value === '' || value === '|' || value === '>') {
        out[currentKey] = value === '' ? '' : value;
        continue;
      }
      out[currentKey] = stripQuotes(value);
    }
  }
  return out;
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseFeatureFile(absolutePath) {
  const raw = readFileSync(absolutePath, 'utf8');
  const match = raw.match(FRONTMATTER_RE);
  const meta = match ? parseSimpleYaml(match[1]) : {};
  const body = match ? raw.slice(match[0].length) : raw;
  const id = meta.id || basename(absolutePath, '.md');
  const testids = Array.isArray(meta.testids)
    ? meta.testids
    : typeof meta.testids === 'string' && meta.testids
      ? [meta.testids]
      : [];
  return {
    id,
    path: absolutePath,
    prove: typeof meta.prove === 'string' ? meta.prove : '',
    testids,
    body,
    meta,
  };
}

export function listFeatureFiles(featuresRoot) {
  if (!existsSync(featuresRoot)) return [];
  return readdirSync(featuresRoot)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .map((name) => join(featuresRoot, name))
    .filter((path) => statSync(path).isFile())
    .sort();
}

export function loadFeatureMap(featuresRoot) {
  return listFeatureFiles(featuresRoot).map(parseFeatureFile);
}

export function findFeature(featuresRoot, featureId) {
  const needle = featureId.replace(/\.md$/i, '');
  const all = loadFeatureMap(featuresRoot);
  return all.find((f) => f.id === needle || basename(f.path, '.md') === needle) ?? null;
}
