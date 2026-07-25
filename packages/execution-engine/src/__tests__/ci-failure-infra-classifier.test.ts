import { describe, expect, it, vi } from 'vitest';

import {
  classifyFailedChecks,
  createFailedCheckLogFetcher,
  isInfraCiFailureLog,
  parseActionsDetailsUrl,
} from '../ci-failure-infra-classifier.js';
import { PR_5188_INFRA_LOG } from './fixtures/pr-5188-infra-ci-log.js';

const CODE_FAILURE_LOG = `
FAIL src/example.test.ts > does the thing
AssertionError: expected 1 to be 2
`;

describe('parseActionsDetailsUrl', () => {
  it('parses run and job ids from Actions details URLs', () => {
    expect(parseActionsDetailsUrl(
      'https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/29723090393/job/88290047107',
    )).toEqual({ runId: '29723090393', jobId: '88290047107' });
  });

  it('parses run-only URLs', () => {
    expect(parseActionsDetailsUrl(
      'https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/29723090393',
    )).toEqual({ runId: '29723090393' });
  });

  it('returns null for non-Actions URLs', () => {
    expect(parseActionsDetailsUrl('https://example.com/checks/1')).toBeNull();
  });
});

describe('isInfraCiFailureLog', () => {
  it('matches PR #5188 packed-refs / EACCES checkout failure', () => {
    expect(isInfraCiFailureLog(PR_5188_INFRA_LOG)).toBe(true);
  });

  it('rejects ordinary test failure logs', () => {
    expect(isInfraCiFailureLog(CODE_FAILURE_LOG)).toBe(false);
  });
});

describe('classifyFailedChecks', () => {
  const checks = [
    {
      name: 'PR Body',
      conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/29723090425/job/88290047072',
    },
    {
      name: 'quality / Dependency Cruise',
      conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/29723090393/job/88290047107',
    },
  ];

  it('classifies infra when every fetched log is infra', () => {
    const logs = new Map(checks.map((check) => [check.detailsUrl!, PR_5188_INFRA_LOG]));
    expect(classifyFailedChecks(checks, logs)).toMatchObject({
      classification: 'infra',
      classifiedCheckCount: 2,
    });
  });

  it('classifies code when any fetched log is not infra', () => {
    const logs = new Map<string, string>([
      [checks[0].detailsUrl!, PR_5188_INFRA_LOG],
      [checks[1].detailsUrl!, CODE_FAILURE_LOG],
    ]);
    expect(classifyFailedChecks(checks, logs).classification).toBe('code');
  });

  it('classifies unknown when no logs are available', () => {
    expect(classifyFailedChecks(checks, new Map()).classification).toBe('unknown');
  });
});

describe('createFailedCheckLogFetcher', () => {
  it('fetches job-scoped failed logs via gh', async () => {
    const runGh = vi.fn(async () => PR_5188_INFRA_LOG);
    const fetchLogs = createFailedCheckLogFetcher({ cwd: '/tmp', runGh });
    const url = 'https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/1/job/2';
    const logs = await fetchLogs([{ name: 'PR Body', detailsUrl: url }]);
    expect(runGh).toHaveBeenCalledWith(['run', 'view', '--log-failed', '--job', '2'], '/tmp');
    expect(logs.get(url)).toBe(PR_5188_INFRA_LOG);
  });

  it('fails open when gh errors', async () => {
    const fetchLogs = createFailedCheckLogFetcher({
      runGh: async () => {
        throw new Error('boom');
      },
    });
    const url = 'https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/1/job/2';
    const logs = await fetchLogs([{ name: 'PR Body', detailsUrl: url }]);
    expect(logs.size).toBe(0);
  });
});
