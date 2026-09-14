#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_STATE = { consecutiveExhausted: 0 };

export function isActionsConcurrencyExhausted({
  listQueuedRunCount,
  debounceStatePath,
  threshold,
  requiredConsecutivePolls,
  readState,
  writeState,
}) {
  const queuedRunCount = listQueuedRunCount();

  if (queuedRunCount >= threshold) {
    const state = readState(debounceStatePath) ?? DEFAULT_STATE;
    const nextState = {
      consecutiveExhausted: (state.consecutiveExhausted ?? 0) + 1,
    };
    writeState(debounceStatePath, nextState);
    return nextState.consecutiveExhausted >= requiredConsecutivePolls;
  }

  writeState(debounceStatePath, DEFAULT_STATE);
  return false;
}

function parseIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isNaN(value) ? fallback : value;
}

function repoFromRemoteUrl(remoteUrl) {
  const trimmed = remoteUrl.trim();
  const match = trimmed.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`could not parse owner/repo from origin remote URL: ${trimmed}`);
  }
  return match[1];
}

function getRepo() {
  if (process.env.INVOKER_JAILBREAK_REPO) {
    return process.env.INVOKER_JAILBREAK_REPO;
  }
  const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  return repoFromRemoteUrl(remoteUrl);
}

function readJsonState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      return DEFAULT_STATE;
    }
    throw e;
  }
}

function writeJsonState(path, state) {
  writeFileSync(path, `${JSON.stringify(state)}\n`);
}

function main() {
  const repo = getRepo();
  const debounceStatePath =
    process.env.INVOKER_JAILBREAK_DEBOUNCE_STATE_PATH ??
    `${process.env.TMPDIR || '/tmp'}/invoker-jailbreak-debounce.json`;

  // Unverified placeholder defaults pending real observed data; these are not calibrated thresholds.
  const threshold = parseIntegerEnv('INVOKER_JAILBREAK_QUEUED_THRESHOLD', 40);
  const requiredConsecutivePolls = parseIntegerEnv('INVOKER_JAILBREAK_CONSECUTIVE_POLLS', 3);

  let ghApiError;
  const listQueuedRunCount = () => {
    try {
      const output = execFileSync(
        'gh',
        ['api', `repos/${repo}/actions/runs?status=queued&per_page=1`, '--jq', '.total_count'],
        { encoding: 'utf8' },
      );
      return Number.parseInt(output.trim(), 10);
    } catch (e) {
      ghApiError = e;
      throw e;
    }
  };

  let exhausted;
  try {
    exhausted = isActionsConcurrencyExhausted({
      listQueuedRunCount,
      debounceStatePath,
      threshold,
      requiredConsecutivePolls,
      readState: readJsonState,
      writeState: writeJsonState,
    });
  } catch (e) {
    if (!ghApiError) {
      throw e;
    }
    console.error(`error: failed to read queued GitHub Actions runs via gh: ${ghApiError.message}`);
    process.exit(2);
  }

  process.exit(exhausted ? 0 : 1);
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
