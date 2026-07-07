/**
 * Headless web-surface bootstrap.
 *
 * The GUI owner already builds a `WorkflowRollupProjection` + task-graph
 * publisher and subscribes to `task.delta`; it wires the web bridge directly
 * onto that existing publisher. Headless owners (the DO box, standalone /
 * owner-serve, `--headless run|resume|slack`) have no such pipeline, so this
 * helper stands up a sink-only projection + publisher and feeds the web
 * bridge's SSE stream — keeping a single projection instance per process.
 *
 * Returns `null` (and logs one line) when no web token is configured, so call
 * sites can unconditionally invoke it.
 */

import type {
  BundledSkillsStatus,
  Logger,
  WorkflowMeta,
} from '@invoker/contracts';
import { Channels, type MessageBus } from '@invoker/transport';
import type { SQLiteAdapter } from '@invoker/data-store';
import { createWorkerRegistry, registerBuiltinAgents, registerBuiltinWorkers, type AgentRegistry, type WorkerRuntimeDependencies } from '@invoker/execution-engine';
import type { Orchestrator, TaskDelta } from '@invoker/workflow-core';
import { loadConfig, type InvokerConfig } from '../config.js';
import type { ApiMutationFacade } from '../api-server.js';
import { createTaskGraphEventPublisher } from '../task-graph-event-publisher.js';
import { createTaskDeltaStreamSequence } from '../task-delta-stream-sequence.js';
import { WorkflowRollupProjection } from '../workflow-rollup-projection.js';
import { buildWebInvokerDispatch } from './web-invoker-dispatch.js';
import { registerExternalWorkersFromConfig } from '../external-worker-loader.js';
import { AUTO_STARTED_OWNER_WORKER_KINDS, createLocalWorkerStatusSnapshot } from '../worker-control.js';
import { startWebBridge, resolveWebUiDistDir, type WebBridge } from './web-bridge-server.js';

const DEFAULT_WEB_HOST = '127.0.0.1';
const DEFAULT_WEB_PORT = 4200;

/** Shared secret enabling the web surface; env wins over config. Undefined disables it. */
export function resolveWebToken(config: Pick<InvokerConfig, 'webToken'>): string | undefined {
  const fromEnv = process.env.INVOKER_WEB_TOKEN;
  return fromEnv && fromEnv.length > 0 ? fromEnv : config.webToken;
}

export function resolveWebHost(config: Pick<InvokerConfig, 'webHost'>): string {
  return process.env.INVOKER_WEB_HOST ?? config.webHost ?? DEFAULT_WEB_HOST;
}

export function resolveWebPort(config: Pick<InvokerConfig, 'webPort'>): number {
  const raw = process.env.INVOKER_WEB_PORT ?? (config.webPort != null ? String(config.webPort) : undefined);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : DEFAULT_WEB_PORT;
}

export interface StartHeadlessWebSurfaceDeps {
  logger: Logger;
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  messageBus: MessageBus;
  agentRegistry: AgentRegistry;
  mutations: ApiMutationFacade;
  deleteWorkflow: (workflowId: string) => Promise<void>;
  detachWorkflow: (workflowId: string, upstreamWorkflowId: string) => Promise<void>;
  loadConfig: () => InvokerConfig;
  config: InvokerConfig;
  /** Main process dist directory (`__dirname` of main.js) used to locate the built UI. */
  appRootDir: string;
  getBundledSkillsStatus?: () => BundledSkillsStatus;
}

export function startHeadlessWebSurface(deps: StartHeadlessWebSurfaceDeps): WebBridge | null {
  const token = resolveWebToken(deps.config);
  if (!token) {
    deps.logger.info(
      'Web surface disabled — set INVOKER_WEB_TOKEN (or config.webToken) to enable it',
      { module: 'web-bridge' },
    );
    return null;
  }

  const host = resolveWebHost(deps.config);
  const port = resolveWebPort(deps.config);
  const uiDistDir = resolveWebUiDistDir(deps.appRootDir);

  const streamSeq = createTaskDeltaStreamSequence();
  const projection = new WorkflowRollupProjection();
  let bridge: WebBridge | null = null;

  const publisher = createTaskGraphEventPublisher({
    getMainWindow: () => null,
    isUiInteractive: () => false,
    stampDelta: (delta) => streamSeq.stamp(delta),
    getStreamSequence: () => streamSeq.current(),
    onEvent: (event) => bridge?.broadcast('invoker:task-graph-event', event),
  });

  const unsubscribe = deps.messageBus.subscribe(Channels.TASK_DELTA, (delta: unknown) => {
    const d = delta as TaskDelta;
    const rollups = projection.applyDelta(d);
    publisher.publishDelta(d, rollups);
  });

  const refreshTaskGraph = async (): Promise<void> => {
    deps.orchestrator.syncAllFromDb();
    const tasks = deps.orchestrator.getAllTasks();
    projection.replaceAll(tasks);
    publisher.publishSnapshot(
      'refresh-task-graph',
      tasks,
      deps.persistence.listWorkflows() as WorkflowMeta[],
      true,
    );
  };

  const dispatch = buildWebInvokerDispatch({
    orchestrator: deps.orchestrator,
    persistence: deps.persistence,
    mutations: deps.mutations,
    agentRegistry: deps.agentRegistry,
    loadConfig: deps.loadConfig,
    getStreamSequence: () => streamSeq.current(),
    refreshTaskGraph,
    deleteWorkflow: deps.deleteWorkflow,
    detachWorkflow: deps.detachWorkflow,
    getBundledSkillsStatus: deps.getBundledSkillsStatus,
    getWorkers: () => createLocalWorkerStatusSnapshot({
      registry: registerExternalWorkersFromConfig(
        deps.config.externalWorkers,
        registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>()),
      ),
      persistence: deps.persistence,
      autoStartKinds: AUTO_STARTED_OWNER_WORKER_KINDS,
    }),
    logger: deps.logger,
  });

  bridge = startWebBridge({
    logger: deps.logger,
    dispatch,
    messageBus: deps.messageBus,
    persistence: deps.persistence,
    uiDistDir,
    token,
    host,
    port,
  });

  const originalClose = bridge.close;
  return {
    whenReady: bridge.whenReady,
    broadcast: bridge.broadcast,
    get port(): number {
      return bridge!.port;
    },
    close: async (): Promise<void> => {
      unsubscribe?.();
      await originalClose();
    },
  };
}

/** Structural subset of HeadlessDeps the web surface needs (avoids importing headless-shared and the import cycle it would create). */
export interface HeadlessWebSurfaceHost {
  logger: Logger;
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  messageBus: MessageBus;
  executionAgentRegistry?: AgentRegistry;
  invokerConfig: InvokerConfig;
  appRootDir?: string;
  getBundledSkillsStatus?: () => BundledSkillsStatus;
}

/**
 * Start the optional web surface for a headless command, reusing the mutation
 * facade already built for the REST api-server. Returns null when no web token
 * is configured. Callers close the returned bridge alongside `api.close()`.
 */
export function startWebSurfaceForHeadless(
  host: HeadlessWebSurfaceHost,
  apiServerDeps: {
    mutations: ApiMutationFacade;
    deleteWorkflow: (workflowId: string) => Promise<void>;
    detachWorkflow: (workflowId: string, upstreamWorkflowId: string) => Promise<void>;
  },
): WebBridge | null {
  return startHeadlessWebSurface({
    logger: host.logger,
    orchestrator: host.orchestrator,
    persistence: host.persistence,
    messageBus: host.messageBus,
    agentRegistry: host.executionAgentRegistry ?? registerBuiltinAgents(),
    mutations: apiServerDeps.mutations,
    deleteWorkflow: apiServerDeps.deleteWorkflow,
    detachWorkflow: apiServerDeps.detachWorkflow,
    loadConfig,
    config: host.invokerConfig,
    appRootDir: host.appRootDir ?? __dirname,
    getBundledSkillsStatus: host.getBundledSkillsStatus,
  });
}
