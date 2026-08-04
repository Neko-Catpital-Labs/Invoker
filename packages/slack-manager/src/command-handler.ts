/**
 * CommandHandler — the `onCommand` passed to `slack.start()`. Translates surface
 * commands into delegated Invoker actions over IPC. Each command is wrapped in
 * launch-and-retry-once-if-down; if Invoker stays down, an error is posted back.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CommandHandler, SurfaceCommand, SurfaceEvent } from '@invoker/surfaces';
import { InvokerDownError, describeInvokerDown, type InvokerClient } from './invoker-client.js';
import { errMessage } from './util.js';

export interface CommandHandlerDeps {
  client: InvokerClient;
  slack: { handleEvent: (event: SurfaceEvent) => Promise<void> };
  /** Directory plan YAML files are written to before `headless run`. */
  plansDir: string;
  log: (level: string, message: string) => void;
}

export class SlackCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackCommandError';
  }
}

export function createCommandHandler(deps: CommandHandlerDeps): CommandHandler {
  const startedPlans = new Map<string, string[]>();
  return async (command: SurfaceCommand) => {
    try {
      return await deps.client.withRecovery(() => dispatch(deps, command, startedPlans));
    } catch (err) {
      const message = err instanceof InvokerDownError
        ? describeInvokerDown(err)
        : `Command \`${command.type}\` failed: ${errMessage(err)}`;
      deps.log('error', message);
      throw err instanceof SlackCommandError ? err : new SlackCommandError(message);
    }
  };
}

async function dispatch(
  deps: CommandHandlerDeps,
  command: SurfaceCommand,
  startedPlans: Map<string, string[]>,
): Promise<{ workflowIds?: string[] } | void> {
  const { client, slack, plansDir, log } = deps;
  switch (command.type) {
    case 'approve':
      await client.exec(['approve', command.taskId]);
      return;
    case 'reject':
      await client.exec(['reject', command.taskId, ...(command.reason ? [command.reason] : [])]);
      return;
    case 'provide_input':
      await client.exec(['input', command.taskId, command.input]);
      return;
    case 'select_experiment':
      await client.exec(['select', command.taskId, command.experimentId]);
      return;
    case 'retry':
      await client.exec(['retry-task', command.taskId]);
      return;
    case 'get_status': {
      const status = await client.getWorkflowStatus(command.workflowId);
      await slack.handleEvent({ type: 'workflow_status', status, workflowId: command.workflowId });
      return;
    }
    case 'start_plan': {
      mkdirSync(plansDir, { recursive: true });
      const cachedWorkflowIds = command.executionKey ? startedPlans.get(command.executionKey) : undefined;
      const planPath = path.join(plansDir, `manager-${command.executionKey ?? Date.now()}.yaml`);
      if (!cachedWorkflowIds) writeFileSync(planPath, command.planText, 'utf8');
      const workflowIds = cachedWorkflowIds ?? (await client.run(planPath)).workflowIds;
      if (command.executionKey) startedPlans.set(command.executionKey, workflowIds);
      log('info', `submitted plan → workflow(s) ${workflowIds.join(', ')}`);
      for (const workflowId of workflowIds) {
        await slack.handleEvent({
          type: 'workflow_created',
          workflowId,
          requestedBy: command.requestedBy,
          lobbyChannel: command.lobbyChannel,
          lobbyThreadTs: command.lobbyThreadTs,
          harnessPreset: command.harnessPreset,
          repoUrl: command.repoUrl,
          planFile: planPath,
        });
      }
      return { workflowIds };
    }
  }
}
