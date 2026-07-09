#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const DEFAULT_COMMANDS = ['claude', 'codex', 'pnpm'];
const FATAL_HEADER = 'FATAL: Invoker command concurrency invariant violated';

function parseArgs(argv) {
  const opts = {
    max: 1,
    commands: DEFAULT_COMMANDS,
    action: 'kill-owner',
    repoRoot: resolve(new URL('..', import.meta.url).pathname),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--max') opts.max = Number.parseInt(argv[++i] ?? '', 10);
    else if (arg === '--commands') opts.commands = String(argv[++i] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    else if (arg === '--action') opts.action = argv[++i];
    else if (arg === '--owner-pid') opts.ownerPid = Number.parseInt(argv[++i] ?? '', 10);
    else if (arg === '--snapshot-file') opts.snapshotFile = argv[++i];
    else if (arg === '--repo-root') opts.repoRoot = resolve(argv[++i] ?? '.');
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(opts.max) || opts.max < 1) throw new Error('--max must be a positive integer');
  if (opts.action !== 'kill-owner' && opts.action !== 'report') throw new Error('--action must be kill-owner or report');
  return opts;
}

function usage() {
  return [
    'usage: invoker-command-concurrency-watchdog.mjs [--max N] [--commands a,b] [--action kill-owner|report]',
    '       [--owner-pid PID] [--snapshot-file PATH] [--repo-root PATH]',
  ].join('\n');
}

function shellSplit(line) {
  const out = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;
  while ((match = re.exec(line)) != null) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

function normalizeProcess(row) {
  const args = Array.isArray(row.args) ? row.args.join(' ') : String(row.args ?? row.command ?? '');
  return {
    pid: Number(row.pid),
    ppid: Number(row.ppid ?? 0),
    command: String(row.command ?? row.comm ?? shellSplit(args)[0] ?? ''),
    args,
    cwd: row.cwd ? String(row.cwd) : undefined,
  };
}

export function parseProcessSnapshot(raw) {
  const trimmed = String(raw).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('JSON snapshot must be an array');
    return parsed.map(normalizeProcess).filter((p) => Number.isInteger(p.pid));
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  return lines.map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) throw new Error(`invalid ps snapshot line: ${line}`);
    return normalizeProcess({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
      args: match[4] || match[3],
    });
  });
}

function readLiveProcesses() {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' });
  const rows = parseProcessSnapshot(output);
  if (process.platform !== 'linux') return rows;
  return rows.map((row) => {
    const cwdLink = `/proc/${row.pid}/cwd`;
    if (!existsSync(cwdLink)) return row;
    try {
      return { ...row, cwd: execFileSync('readlink', ['-f', cwdLink], { encoding: 'utf8' }).trim() };
    } catch {
      return row;
    }
  });
}

function commandName(proc) {
  const fromCommand = basename(proc.command || '');
  const firstArg = basename(shellSplit(proc.args)[0] ?? '');
  return fromCommand || firstArg;
}

function isGuarded(proc, commands) {
  const names = new Set([commandName(proc), basename(shellSplit(proc.args)[0] ?? '')].filter(Boolean));
  return commands.some((cmd) => names.has(cmd));
}

function isOwner(proc, ownerPid) {
  if (ownerPid && proc.pid === ownerPid) return true;
  const args = proc.args;
  if (!args.includes('packages/app/dist/main.js') && !args.includes('/dist/main.js')) return false;
  return /(^|\s)(electron|Electron|node)(\s|$|\/)/.test(args) || args.includes('--headless');
}

function hasAncestor(proc, ownerPids, byPid) {
  const seen = new Set();
  let ppid = proc.ppid;
  while (ppid && !seen.has(ppid)) {
    if (ownerPids.has(ppid)) return ppid;
    seen.add(ppid);
    ppid = byPid.get(ppid)?.ppid;
  }
  return undefined;
}

function isInvokerManagedCwd(cwd) {
  if (!cwd) return false;
  const normalized = resolve(cwd);
  return normalized.includes('/.invoker/worktrees/')
    || normalized.includes('/.invoker/test/worktrees/')
    || normalized.includes('/.invoker/repos/')
    || normalized.includes('/.invoker/test/repos/')
    || normalized.includes('/invoker-worktrees/')
    || normalized.includes('/invoker-runtime/');
}

export function evaluateSnapshot(processes, options = {}) {
  const commands = options.commands ?? DEFAULT_COMMANDS;
  const max = options.max ?? 1;
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const ownerPids = new Set(processes.filter((proc) => isOwner(proc, options.ownerPid)).map((proc) => proc.pid));
  if (options.ownerPid) ownerPids.add(options.ownerPid);

  const offenders = [];
  for (const proc of processes) {
    if (!isGuarded(proc, commands)) continue;
    const ownerPid = hasAncestor(proc, ownerPids, byPid);
    if (ownerPid) {
      offenders.push({ ...proc, ownerPid, ownership: 'ancestor' });
      continue;
    }
    const platform = options.platform ?? process.platform;
    if (ownerPids.size === 0 && platform === 'linux' && isInvokerManagedCwd(proc.cwd)) {
      offenders.push({ ...proc, ownerPid: undefined, ownership: 'cwd' });
    }
  }
  return {
    ok: offenders.length <= max,
    max,
    count: offenders.length,
    ownerPids: [...ownerPids],
    offenders,
  };
}

export function formatViolation(result) {
  const lines = [
    FATAL_HEADER,
    `observed guarded processes: ${result.count}; max allowed: ${result.max}`,
  ];
  if (result.ownerPids.length > 0) lines.push(`owner PID(s): ${result.ownerPids.join(', ')}`);
  for (const proc of result.offenders) {
    lines.push(`- pid=${proc.pid} ppid=${proc.ppid} ownerPid=${proc.ownerPid ?? 'unknown'} command=${commandName(proc)} args=${proc.args}`);
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const processes = opts.snapshotFile
    ? parseProcessSnapshot(readFileSync(opts.snapshotFile, 'utf8'))
    : readLiveProcesses();
  const result = evaluateSnapshot(processes, opts);
  if (result.ok) return 0;
  process.stderr.write(formatViolation(result));
  if (opts.action === 'kill-owner') {
    for (const ownerPid of result.ownerPids) {
      try {
        process.kill(ownerPid, 'SIGTERM');
        process.stderr.write(`sent SIGTERM to owner PID ${ownerPid}\n`);
      } catch (err) {
        process.stderr.write(`failed to SIGTERM owner PID ${ownerPid}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${usage()}\n`);
    process.exitCode = 2;
  }
}
