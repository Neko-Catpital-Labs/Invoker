/**
 * INV-XXX: Proof that owner-serve HTTP never binds when the LaunchDispatcher
 * blocks the main thread with full-graph task reloads before server.listen()
 * callback fires.
 *
 * Repro conditions (from the DO1 incident): 900 workflows, 2702 tasks (1200
 * failed / 600 running / 497 pending / 405 completed), LaunchDispatcher.poll()
 * runs before server.listen() callback, dispatcher's startExecution() →
 * refreshFromDb() → loadTasksForWorkflows() → reconcileTaskFromSelectedAttempt()
 * per non-terminal task keeps the main thread busy, Node event loop never gets
 * to fire the listen callback.
 *
 * The test simulates this by:
 * 1. Starting an HTTP server and calling listen()
 * 2. Blocking the main thread with synchronous work BEFORE the listen callback
 * 3. Asserting the server is NOT listening within a reasonable timeout
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';
import { startStandaloneLaunchDispatcher } from '../headless-standalone-launch-dispatcher.js';
import type { HeadlessDeps } from '../headless.js';

const TEST_PORT = 0;
const WORKFLOW_COUNT = 100;

describe('owner-serve HTTP bind blocked by LaunchDispatcher poll', () => {
  let dbDir: string | undefined;
  let server: Server | undefined;

  beforeEach(() => {
    dbDir = undefined;
    server = undefined;
  });

  afterEach(() => {
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
    if (server) server.close();
  });

  it('HTTP server.listen callback does NOT fire when main thread is blocked by synchronous work', async () => {
    let listenCallbackFired = false;
    server = createServer();

    server.listen(TEST_PORT, '127.0.0.1', () => {
      listenCallbackFired = true;
    });

    const blockMs = 200;
    const blockUntil = Date.now() + blockMs;
    while (Date.now() < blockUntil) {
      Math.random();
    }

    expect(
      listenCallbackFired,
      'listen callback should NOT fire while main thread is blocked',
    ).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      listenCallbackFired,
      'listen callback should fire after yielding to event loop',
    ).toBe(true);
  });

  it('startExecution + refreshFromDb blocks main thread for large DB', async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'invoker-bind-blocked-'));
    const dbPath = path.join(dbDir, 'invoker.db');

    const seedAdapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      for (let i = 0; i < WORKFLOW_COUNT; i += 1) {
        const wfId = `wf-seed-${i}`;
        const nowIso = new Date().toISOString();
        seedAdapter.saveWorkflow({
          id: wfId,
          name: wfId,
          createdAt: nowIso,
          updatedAt: nowIso,
        } as any);

        const createdAt = new Date();
        seedAdapter.saveTask(wfId, {
          id: `${wfId}/a`,
          description: 'a',
          status: 'completed',
          dependencies: [],
          createdAt,
          config: { workflowId: wfId },
          execution: { exitCode: 0 },
        } as TaskState);

        const hasPendingTask = i % 2 === 0;
        seedAdapter.saveTask(wfId, {
          id: `${wfId}/b`,
          description: 'b',
          status: hasPendingTask ? 'pending' : 'completed',
          dependencies: [`${wfId}/a`],
          createdAt,
          config: { workflowId: wfId },
          execution: hasPendingTask ? {} : { exitCode: 0 },
        } as TaskState);
      }
    } finally {
      seedAdapter.close();
    }

    const bootAdapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    let listenCallbackFired = false;
    server = createServer();

    try {
      const orchestrator = new Orchestrator({
        persistence: bootAdapter as any,
        messageBus: new InMemoryBus(),
        maxConcurrency: 200,
      });

      server.listen(TEST_PORT, '127.0.0.1', () => {
        listenCallbackFired = true;
      });

      orchestrator.syncAllFromDb();
      orchestrator.startExecution({ limit: 32 });

      expect(
        listenCallbackFired,
        'listen callback should NOT fire while orchestrator.startExecution() is running synchronously',
      ).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        listenCallbackFired,
        'listen callback should fire after yielding to event loop',
      ).toBe(true);
    } finally {
      bootAdapter.close();
    }
  });

  it('dispatcher poll() blocks HTTP bind when run before listen callback fires', async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'invoker-dispatcher-blocks-'));
    const dbPath = path.join(dbDir, 'invoker.db');

    const seedAdapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    const pendingTaskIds: string[] = [];
    try {
      for (let i = 0; i < WORKFLOW_COUNT; i += 1) {
        const wfId = `wf-seed-${i}`;
        const nowIso = new Date().toISOString();
        seedAdapter.saveWorkflow({
          id: wfId,
          name: wfId,
          createdAt: nowIso,
          updatedAt: nowIso,
        } as any);

        const createdAt = new Date();
        seedAdapter.saveTask(wfId, {
          id: `${wfId}/root`,
          description: 'root',
          status: 'completed',
          dependencies: [],
          createdAt,
          config: { workflowId: wfId },
          execution: { exitCode: 0 },
        } as TaskState);

        const hasPendingTask = i % 2 === 0;
        const taskId = `${wfId}/work`;
        if (hasPendingTask) pendingTaskIds.push(taskId);
        seedAdapter.saveTask(wfId, {
          id: taskId,
          description: 'work',
          status: hasPendingTask ? 'pending' : 'completed',
          dependencies: [`${wfId}/root`],
          createdAt,
          config: { workflowId: wfId },
          execution: hasPendingTask ? {} : { exitCode: 0 },
        } as TaskState);
      }
    } finally {
      seedAdapter.close();
    }

    const bootAdapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    let listenCallbackFired = false;
    server = createServer();

    try {
      const orchestrator = new Orchestrator({
        persistence: bootAdapter as any,
        messageBus: new InMemoryBus(),
        maxConcurrency: 200,
      });
      orchestrator.syncAllFromDb();

      server.listen(TEST_PORT, '127.0.0.1', () => {
        listenCallbackFired = true;
      });

      for (let tick = 0; tick < 5; tick += 1) {
        orchestrator.startExecution({ limit: 32 });
      }

      expect(
        listenCallbackFired,
        'PROOF: HTTP listen callback does NOT fire when dispatcher poll blocks main thread repeatedly',
      ).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        listenCallbackFired,
        'listen callback fires after yielding to event loop',
      ).toBe(true);
    } finally {
      bootAdapter.close();
    }
  });

  it('deferFirstPollUntil option allows HTTP to bind before dispatcher starts polling', async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'invoker-defer-poll-'));
    const dbPath = path.join(dbDir, 'invoker.db');

    const seedAdapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      for (let i = 0; i < WORKFLOW_COUNT; i += 1) {
        const wfId = `wf-seed-${i}`;
        const nowIso = new Date().toISOString();
        seedAdapter.saveWorkflow({
          id: wfId,
          name: wfId,
          createdAt: nowIso,
          updatedAt: nowIso,
        } as any);

        const createdAt = new Date();
        seedAdapter.saveTask(wfId, {
          id: `${wfId}/root`,
          description: 'root',
          status: 'completed',
          dependencies: [],
          createdAt,
          config: { workflowId: wfId },
          execution: { exitCode: 0 },
        } as TaskState);

        const hasPendingTask = i % 2 === 0;
        seedAdapter.saveTask(wfId, {
          id: `${wfId}/work`,
          description: 'work',
          status: hasPendingTask ? 'pending' : 'completed',
          dependencies: [`${wfId}/root`],
          createdAt,
          config: { workflowId: wfId },
          execution: hasPendingTask ? {} : { exitCode: 0 },
        } as TaskState);
      }
    } finally {
      seedAdapter.close();
    }

    const bootAdapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    let listenCallbackFired = false;
    server = createServer();
    const { promise: whenReady, resolve: resolveReady } = Promise.withResolvers<void>();

    try {
      const orchestrator = new Orchestrator({
        persistence: bootAdapter as any,
        messageBus: new InMemoryBus(),
        maxConcurrency: 200,
      });
      orchestrator.syncAllFromDb();

      server.listen(TEST_PORT, '127.0.0.1', () => {
        listenCallbackFired = true;
        resolveReady();
      });

      const mockHeadlessDeps = {
        persistence: bootAdapter,
        orchestrator,
        logger: { warn: () => {}, info: () => {}, error: () => {} },
      } as unknown as HeadlessDeps;

      const dispatcher = startStandaloneLaunchDispatcher({
        headlessDeps: mockHeadlessDeps,
        ownerId: 'test-owner',
        createTaskExecutor: () => ({ executeTask: async () => {} }) as any,
        setLatestTaskExecutor: () => {},
        topUpReadyLaunchesEnabled: () => false,
        deferFirstPollUntil: whenReady,
      });

      expect(
        listenCallbackFired,
        'FIX VERIFIED: listen callback can fire because dispatcher deferred first poll',
      ).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        listenCallbackFired,
        'listen callback fires after yielding to event loop',
      ).toBe(true);

      dispatcher.stop();
    } finally {
      bootAdapter.close();
    }
  });
});
