import { describe, it, expect, beforeEach } from 'vitest';
import {
  createGraphCameraCommandIssuer,
  isGraphScope,
} from '../lib/graph-camera.js';

describe('graph-camera type guards', () => {
  it('recognizes valid graph scopes', () => {
    expect(isGraphScope('workflow')).toBe(true);
    expect(isGraphScope('task')).toBe(true);
  });

  it('rejects invalid graph scopes', () => {
    expect(isGraphScope('graph')).toBe(false);
    expect(isGraphScope(null)).toBe(false);
  });
});

describe('graph-camera command issuer', () => {
  let issuer: ReturnType<typeof createGraphCameraCommandIssuer>;

  beforeEach(() => {
    issuer = createGraphCameraCommandIssuer();
  });

  it('starts at sequence 0 and issues monotonically increasing sequences', () => {
    expect(issuer.current()).toBe(0);
    const first = issuer.issue({ kind: 'centerSelection', scope: 'workflow', reason: 'select' });
    const second = issuer.issue({ kind: 'fitInitial', scope: 'task', reason: 'mount' });
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(issuer.current()).toBe(2);
  });

  it('builds centerSelection commands with scope, target and reason', () => {
    const command = issuer.centerSelection('task', 'task-7', 'user click');
    expect(command).toEqual({
      kind: 'centerSelection',
      scope: 'task',
      target: 'task-7',
      reason: 'user click',
      sequence: 1,
    });
  });

  it('builds fitInitial commands with a null target', () => {
    const command = issuer.fitInitial('workflow');
    expect(command.kind).toBe('fitInitial');
    expect(command.scope).toBe('workflow');
    expect(command.target).toBeNull();
    expect(command.reason).toBe('fitInitial');
    expect(command.sequence).toBe(1);
  });

  it('defaults an omitted target to null', () => {
    const command = issuer.issue({ kind: 'fitInitial', scope: 'workflow', reason: 'reset' });
    expect(command.target).toBeNull();
  });

  it('keeps independent sequences per issuer', () => {
    const other = createGraphCameraCommandIssuer();
    issuer.centerSelection('workflow', 'a');
    issuer.centerSelection('workflow', 'b');
    const otherCommand = other.centerSelection('task', 'c');
    expect(issuer.current()).toBe(2);
    expect(otherCommand.sequence).toBe(1);
  });
});
