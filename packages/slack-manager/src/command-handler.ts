/**
 * CommandHandler — the `onCommand` passed to `slack.start()`. Translates surface
 * commands into delegated Invoker actions over IPC. Each command is wrapped in
 * launch-and-retry-once-if-down; if Invoker stays down, an error is posted back.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CommandHandler, SurfaceCommand, SurfaceEvent } from '@invoker/surfaces';
import { InvokerDownError, type InvokerClient } from './invoker-client.js';
import { errMessage } from './util.js';

export interface CommandHandlerDeps {
  client: InvokerClient;
  slack: { handleEvent: (event: SurfaceEvent) => Promise<void> };
  /** Directory plan YAML files are written to before `headless run`. */
  plansDir: string;
  log: (level: string, message: string) => void;
}

const DOWN_MESSAGE = 'Invoker is down and I could not bring it back. Reply `@Invoker restart` to retry.';

export class SlackCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackCommandError';
  }
}

export function createCommandHandler(deps: CommandHandlerDeps): CommandHandler {
  return async (command: SurfaceCommand): Promise<void> => {
    try {
      await deps.client.withRecovery(() => dispatch(deps, command));
    } catch (err) {
      const message = err instanceof InvokerDownError
        ? DOWN_MESSAGE
        : `Command \`${command.type}\` failed: ${errMessage(err)}`;
      deps.log('error', message);
      throw err instanceof SlackCommandError ? err : new SlackCommandError(message);
    }
  };
}

async function dispatch(deps: CommandHandlerDeps, command: SurfaceCommand): Promise<void> {
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
      const planPath = path.join(plansDir, `manager-${Date.now()}.yaml`);
      writeFileSync(planPath, command.planText, 'utf8');
      const workflowId = await client.run(planPath);
      log('info', `submitted plan → workflow ${workflowId}`);
      await slack.handleEvent({
        type: 'workflow_created',
        workflowId,
        requestedBy: command.requestedBy,
        lobbyChannel: command.lobbyChannel,
        lobbyThreadTs: command.lobbyThreadTs,
        harnessPreset: command.harnessPreset,
        repoUrl: command.repoUrl,
      });
      return;
    }
  }
}
