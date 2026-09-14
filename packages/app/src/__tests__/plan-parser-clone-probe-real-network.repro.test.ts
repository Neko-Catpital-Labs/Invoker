import { describe, it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { assertRepoUrlCloneable } from '../plan-parser.js';

// Real-network repro, no mocks anywhere: a minimal real HTTP server
// fronting `git http-backend` (the same CGI program a real git host runs)
// is started 200ms late by an independent OS process (a detached `sh -c
// 'sleep ...'`), so the probe's *first* `git ls-remote` genuinely hits
// ECONNREFUSED against a real socket on a real https-scheme URL -- matching
// the actual protocol (https://github.com/...) and the same failure shape
// that stuck PR #11153's repair claim on 2026-08-28. The daemon's start
// timing is driven by a separate OS process, not a Node timer, because
// assertRepoUrlCloneable is fully synchronous (execFileSync + Atomics.wait)
// and never yields to the event loop.
async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const address = srv.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

function makeBareRepo(rootDir: string): void {
  const workRepo = join(rootDir, 'work');
  mkdirSync(workRepo);
  execFileSync('git', ['init', '-q', '-b', 'master', workRepo]);
  execFileSync('git', ['-C', workRepo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', workRepo, 'config', 'user.name', 'Test']);
  writeFileSync(join(workRepo, 'f.txt'), 'x\n');
  execFileSync('git', ['-C', workRepo, 'add', 'f.txt']);
  execFileSync('git', ['-C', workRepo, 'commit', '-q', '-m', 'init']);
  execFileSync('git', ['clone', '-q', '--bare', workRepo, join(rootDir, 'repo.git')]);
}

// Minimal real smart-HTTP git server: a genuine `git http-backend` CGI
// subprocess behind a genuine http.Server, exactly the mechanism a real
// git host (e.g. github.com) runs -- not a stand-in for one.
function startRealGitHttpServer(rootDir: string, port: number): http.Server {
  const server = http.createServer((req, res) => {
    const [pathOnly, query = ''] = (req.url ?? '').split('?');
    const cgi = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_HTTP_EXPORT_ALL: '1',
        GIT_PROJECT_ROOT: rootDir,
        PATH_INFO: pathOnly,
        QUERY_STRING: query,
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
      },
    });
    req.pipe(cgi.stdin);
    let buffered = Buffer.alloc(0);
    let headersSent = false;
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (headersSent) {
        res.write(chunk);
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      const sep = buffered.indexOf('\r\n\r\n');
      if (sep === -1) return;
      const headerText = buffered.subarray(0, sep).toString('utf-8');
      const body = buffered.subarray(sep + 4);
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of headerText.split('\r\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key.toLowerCase() === 'status') {
          status = parseInt(value, 10) || 200;
          continue;
        }
        headers[key] = value;
      }
      res.writeHead(status, headers);
      res.write(body);
      headersSent = true;
    });
    cgi.stdout.on('end', () => res.end());
  });
  server.listen(port, '127.0.0.1');
  return server;
}

describe('assertRepoUrlCloneable against a real transient network blip', () => {
  it('survives a real git HTTP server that starts 200ms late (first attempt gets real ECONNREFUSED)', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'clone-probe-repro-'));
    makeBareRepo(rootDir);
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/repo.git`;

    // Fires the real http.Server 200ms from now, from a separate Node
    // process, since the caller below blocks the event loop the whole time.
    const script = `
      setTimeout(() => {
        const http = require('node:http');
        const { spawn } = require('node:child_process');
        const server = http.createServer((req, res) => {
          const [pathOnly, query = ''] = (req.url || '').split('?');
          const cgi = spawn('git', ['http-backend'], {
            env: { ...process.env, GIT_HTTP_EXPORT_ALL: '1', GIT_PROJECT_ROOT: ${JSON.stringify(rootDir)}, PATH_INFO: pathOnly, QUERY_STRING: query, REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] || '' },
          });
          req.pipe(cgi.stdin);
          let buffered = Buffer.alloc(0);
          let headersSent = false;
          cgi.stdout.on('data', (chunk) => {
            if (headersSent) { res.write(chunk); return; }
            buffered = Buffer.concat([buffered, chunk]);
            const sep = buffered.indexOf('\\r\\n\\r\\n');
            if (sep === -1) return;
            const headerText = buffered.subarray(0, sep).toString('utf-8');
            const body = buffered.subarray(sep + 4);
            const headers = {};
            let status = 200;
            for (const line of headerText.split('\\r\\n')) {
              const idx = line.indexOf(':');
              if (idx === -1) continue;
              const key = line.slice(0, idx).trim();
              const value = line.slice(idx + 1).trim();
              if (key.toLowerCase() === 'status') { status = parseInt(value, 10) || 200; continue; }
              headers[key] = value;
            }
            res.writeHead(status, headers);
            res.write(body);
            headersSent = true;
          });
          cgi.stdout.on('end', () => res.end());
        });
        server.listen(${port}, '127.0.0.1');
      }, 200);
    `;
    const delayed = spawn('node', ['-e', script], { stdio: 'ignore', detached: true });
    delayed.unref();

    try {
      expect(() => assertRepoUrlCloneable(url)).not.toThrow();
    } finally {
      try {
        process.kill(-delayed.pid!, 'SIGKILL');
      } catch {
        // already exited
      }
    }
  }, 15_000);
});
