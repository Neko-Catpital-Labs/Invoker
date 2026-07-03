#!/usr/bin/env node
import process from 'node:process';
import { execFile as execFileCb } from 'node:child_process';
import { readFileSync as fsReadFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const POLL_INTERVAL_MS = 200;
const TERM_WAIT_MS = 3_000;
const KILL_WAIT_MS = 1_000;

export function isAutomationChromeCommand(command) {
  return command.includes('puppeteer_dev_chrome_profile-')
    && command.includes('--headless=new');
}

export function extractUserDataDir(command) {
  const match = command.match(/--user-data-dir=([^\s]+)/);
  return match ? match[1] : undefined;
}

export function parsePsSnapshot(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number.parseInt(match[1], 10),
        ppid: Number.parseInt(match[2], 10),
        pgid: Number.parseInt(match[3], 10),
        command: match[4],
      };
    })
    .filter(Boolean);
}

function groupsByPgid(rows, predicate) {
  const byPgid = new Map();
  for (const row of rows) {
    if (!predicate(row)) continue;
    const group = byPgid.get(row.pgid) ?? { pgid: row.pgid, rows: [] };
    group.rows.push(row);
    byPgid.set(row.pgid, group);
  }
  return byPgid;
}

function materializeGroup(group) {
  return {
    pgid: group.pgid,
    pids: [...new Set(group.rows.map((row) => row.pid))].sort((a, b) => a - b),
    profiles: [...new Set(group.rows.flatMap((row) => {
      const userDataDir = extractUserDataDir(row.command);
      return userDataDir ? [userDataDir] : [];
    }))].sort(),
  };
}

export function findOrphanedAutomationChromeGroups(rows) {
  return [...groupsByPgid(rows, (row) => isAutomationChromeCommand(row.command)).values()]
    .filter((group) => group.rows.some((row) => row.ppid === 1))
    .map(materializeGroup)
    .sort((a, b) => a.pgid - b.pgid);
}

export function readTrackedUserDataDirs(registryPath) {
  if (!registryPath) return [];
  return [...new Set(
    fsReadFileSync(registryPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )].sort();
}

export function findTrackedBrowserGroups(rows, trackedUserDataDirs) {
  const tracked = new Set(trackedUserDataDirs);
  if (tracked.size === 0) return [];
  return [...groupsByPgid(rows, (row) => {
    const userDataDir = extractUserDataDir(row.command);
    return userDataDir ? tracked.has(userDataDir) : false;
  }).values()]
    .map(materializeGroup)
    .sort((a, b) => a.pgid - b.pgid);
}

export function mergeGroups(...groupLists) {
  const merged = new Map();
  for (const group of groupLists.flat()) {
    const current = merged.get(group.pgid) ?? { pgid: group.pgid, pids: [], profiles: [] };
    current.pids = [...new Set([...current.pids, ...group.pids])].sort((a, b) => a - b);
    current.profiles = [...new Set([...current.profiles, ...group.profiles])].sort();
    merged.set(group.pgid, current);
  }
  return [...merged.values()].sort((a, b) => a.pgid - b.pgid);
}

export function formatGroup(group) {
  return `pgid=${group.pgid} pids=${group.pids.join(',')} profiles=${group.profiles.join(',')}`;
}

async function readSnapshot() {
  const { stdout } = await execFile('ps', ['-axo', 'pid=,ppid=,pgid=,command=']);
  return parsePsSnapshot(stdout);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGroupExit(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await readSnapshot();
    const stillAlive = rows.some((row) => row.pgid === pgid);
    if (!stillAlive) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

async function terminateGroup(group, signal) {
  process.kill(-group.pgid, signal);
}

export async function cleanupOrphanedAutomationChrome({ dryRun = false, log = console.error, registryPath } = {}) {
  const rows = await readSnapshot();
  const groups = mergeGroups(
    findOrphanedAutomationChromeGroups(rows),
    findTrackedBrowserGroups(rows, readTrackedUserDataDirs(registryPath)),
  );
  if (groups.length === 0) {
    log('cleanup-orphaned-automation-chrome: no orphaned automation Chrome groups found');
    return { cleaned: 0, groups: [] };
  }

  for (const group of groups) {
    log(`cleanup-orphaned-automation-chrome: found ${formatGroup(group)}`);
  }
  if (dryRun) return { cleaned: 0, groups };

  let cleaned = 0;
  for (const group of groups) {
    try {
      await terminateGroup(group, 'SIGTERM');
    } catch (error) {
      if (error?.code === 'ESRCH') {
        cleaned += 1;
        continue;
      }
      throw error;
    }
    const exitedOnTerm = await waitForGroupExit(group.pgid, TERM_WAIT_MS);
    if (!exitedOnTerm) {
      log(`cleanup-orphaned-automation-chrome: escalating ${formatGroup(group)}`);
      try {
        await terminateGroup(group, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
      await waitForGroupExit(group.pgid, KILL_WAIT_MS);
    }
    cleaned += 1;
  }
  return { cleaned, groups };
}

function parseArgs(argv) {
  let dryRun = false;
  let registryPath;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--registry') {
      registryPath = argv[i + 1];
      i += 1;
    }
  }
  return { dryRun, registryPath };
}

async function main(argv) {
  const { dryRun, registryPath } = parseArgs(argv);
  const result = await cleanupOrphanedAutomationChrome({ dryRun, registryPath });
  if (!dryRun && result.cleaned > 0) {
    console.error(`cleanup-orphaned-automation-chrome: cleaned ${result.cleaned} group(s)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`cleanup-orphaned-automation-chrome: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
