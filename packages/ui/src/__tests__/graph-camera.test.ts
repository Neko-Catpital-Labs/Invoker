import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createGraphCameraCommandIssuer,
  isGraphScope,
} from '../lib/graph-camera.js';

// guarded-behavior: selection-camera-inert — see the graph-camera module doc.
// Selection alone must never be able to mint a camera command: these forbidden
// tokens are the API surface that used to let a selection handler recenter the
// viewport. If any of them reappear in App.tsx or graph-camera.ts, selection
// has regained the ability to move the camera.
const FORBIDDEN_SELECTION_CAMERA_TOKENS = [
  'recenterForSelection',
  'centerSelection',
  'SelectByIdOptions',
  'options.recenter',
  'recenter?:',
] as const;

const APP_SOURCE = readFileSync(resolve(__dirname, '..', 'App.tsx'), 'utf-8');
const GRAPH_CAMERA_SOURCE = readFileSync(resolve(__dirname, '..', 'lib', 'graph-camera.ts'), 'utf-8');

describe('selection-camera-inert source invariant', () => {
  it.each(FORBIDDEN_SELECTION_CAMERA_TOKENS)('App.tsx does not contain %s', (token) => {
    expect(APP_SOURCE.split(token)).toHaveLength(1);
  });

  it.each(FORBIDDEN_SELECTION_CAMERA_TOKENS)('graph-camera.ts does not contain %s', (token) => {
    expect(GRAPH_CAMERA_SOURCE.split(token)).toHaveLength(1);
  });
});

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
    const first = issuer.issue({ kind: 'centerTarget', scope: 'workflow', reason: 'select' });
    const second = issuer.issue({ kind: 'fitInitial', scope: 'task', reason: 'mount' });
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(issuer.current()).toBe(2);
  });

  it('builds centerTarget commands with scope, target and reason', () => {
    const command = issuer.centerTarget('task', 'task-7', 'user click');
    expect(command.kind).toBe('centerTarget');
    expect(command.scope).toBe('task');
    expect(command.target).toBe('task-7');
    expect(command.reason).toBe('user click');
    expect(command.sequence).toBe(1);
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
    issuer.centerTarget('workflow', 'a');
    issuer.centerTarget('workflow', 'b');
    const otherCommand = other.centerTarget('task', 'c');
    expect(issuer.current()).toBe(2);
    expect(otherCommand.sequence).toBe(1);
  });
});
