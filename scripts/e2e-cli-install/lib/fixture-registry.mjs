#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

function arg(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (hit === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`fixture-registry: missing required --${name}=`);
  }
  return hit.slice(name.length + 3);
}

function extractPackageJson(tgz, label) {
  const tar = gunzipSync(tgz);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (name === '') {
      throw new Error(`fixture-registry: ${label} ended at the tar terminator with no package/package.json`);
    }
    const rawSize = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(rawSize, 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`fixture-registry: ${label} entry "${name}" has unreadable octal size "${rawSize}"`);
    }
    if (name === 'package/package.json') {
      return tar.subarray(offset + 512, offset + 512 + size).toString('utf8');
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`fixture-registry: ${label} ran past its end with no package/package.json`);
}

const releaseDir = arg('release-dir');
const port = Number(arg('port', '0'));

const packages = new Map();
for (const spec of process.argv.filter((value) => value.startsWith('--package='))) {
  const [name, version, tarballPath] = spec.slice('--package='.length).split('::');
  if (!name || !version || !tarballPath) {
    throw new Error(`fixture-registry: --package= needs name::version::tarball, got "${spec}"`);
  }
  const bytes = readFileSync(tarballPath);
  packages.set(name, {
    name,
    version,
    bytes,
    file: basename(tarballPath),
    manifest: JSON.parse(extractPackageJson(bytes, `${name}@${version}`)),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  });
}
if (packages.size === 0) {
  throw new Error('fixture-registry: no --package= entries supplied');
}

const releaseFiles = new Map();
for (const entry of readdirSync(releaseDir)) {
  const full = join(releaseDir, entry);
  if (statSync(full).isFile()) releaseFiles.set(entry, readFileSync(full));
}

function packument(entry, origin) {
  return {
    _id: entry.name,
    name: entry.name,
    'dist-tags': { latest: entry.version },
    versions: {
      [entry.version]: {
        ...entry.manifest,
        _id: `${entry.name}@${entry.version}`,
        dist: {
          tarball: `${origin}/tarballs/${entry.file}`,
          integrity: entry.integrity,
          shasum: entry.shasum,
        },
      },
    },
  };
}

function notFound(res, path) {
  process.stderr.write(`fixture-registry: 404 ${path}\n`);
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: `fixture-registry has no entry for ${path}` }));
}

const server = createServer((req, res) => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);

  if (path.startsWith('/tarballs/')) {
    const wanted = path.slice('/tarballs/'.length);
    const entry = [...packages.values()].find((candidate) => candidate.file === wanted);
    if (!entry) return notFound(res, path);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return res.end(entry.bytes);
  }

  if (path.startsWith('/release/')) {
    const body = releaseFiles.get(path.slice('/release/'.length));
    if (!body) return notFound(res, path);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return res.end(body);
  }

  const entry = packages.get(path.startsWith('/') ? path.slice(1) : path);
  if (!entry) return notFound(res, path);
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify(packument(entry, origin)));
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`REGISTRY_URL=http://127.0.0.1:${server.address().port}\n`);
});
