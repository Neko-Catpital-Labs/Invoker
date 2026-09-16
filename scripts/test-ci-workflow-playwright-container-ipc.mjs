#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const jobs = workflow.jobs ?? {};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const job = jobs.playwright;
assert(job, 'ci.yml must define the playwright job');
assert(
  job.container?.image === 'mcr.microsoft.com/playwright:v1.58.2-noble',
  'playwright job must keep the pinned Playwright container image',
);
assert(
  String(job.container?.options ?? '').includes('--ipc=host'),
  'playwright job container must run with --ipc=host so Chromium is not constrained by the default '
    + 'Docker /dev/shm size, which is a known source of intermittent Chromium rendering slowdowns',
);

console.log('CI playwright job container IPC policy is valid.');
