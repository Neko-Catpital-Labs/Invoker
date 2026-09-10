import { describe, expect, it } from 'vitest';
import { formatRouteTaskArgs, parseRouteTaskArgs } from '../route-task-args.ts';

describe('parseRouteTaskArgs', () => {
  it('parses every flag regardless of position', () => {
    expect(parseRouteTaskArgs(['--clear-member', '--runner', 'ssh', 'wf-1/task-1', '--agent', 'codex', '--pool', 'p-1', '--force'])).toEqual({
      taskId: 'wf-1/task-1',
      agent: 'codex',
      poolId: 'p-1',
      runnerKind: 'ssh',
      clearMember: true,
      force: true,
    });
  });

  it('defaults the boolean flags to false', () => {
    expect(parseRouteTaskArgs(['wf-1/task-1', '--agent', 'claude'])).toEqual({
      taskId: 'wf-1/task-1',
      agent: 'claude',
      poolId: undefined,
      runnerKind: undefined,
      clearMember: false,
      force: false,
    });
  });

  it.each([
    [[], 'Missing taskId.'],
    [['wf-1/task-1'], 'Nothing to change.'],
    [['wf-1/task-1', '--agent'], 'Missing value for --agent.'],
    [['wf-1/task-1', '--pool', '--force'], 'Missing value for --pool.'],
    [['wf-1/task-1', '--agent', '   '], 'Missing value for --agent.'],
    [['wf-1/task-1', '--runner', 'docker'], 'Unsupported --runner value "docker".'],
    [['wf-1/task-1', '--runner', 'merge'], 'Unsupported --runner value "merge".'],
    [['wf-1/task-1', '--bogus'], 'Unknown option: --bogus.'],
    [['wf-1/task-1', 'wf-1/task-2', '--force'], 'Unexpected argument: wf-1/task-2.'],
  ])('rejects %j', (args, expectedMessage) => {
    expect(() => parseRouteTaskArgs(args)).toThrow(expectedMessage);
  });

  it('round-trips through formatRouteTaskArgs so both call sites agree', () => {
    const cases = [
      ['wf-1/task-1', '--agent', 'codex'],
      ['wf-1/task-1', '--pool', 'p-1'],
      ['wf-1/task-1', '--runner', 'worktree'],
      ['wf-1/task-1', '--clear-member'],
      ['wf-1/task-1', '--agent', 'codex', '--pool', 'p-1', '--runner', 'ssh', '--clear-member', '--force'],
    ];
    for (const args of cases) {
      const parsed = parseRouteTaskArgs(args);
      expect(parseRouteTaskArgs(formatRouteTaskArgs(parsed))).toEqual(parsed);
    }
  });
});
