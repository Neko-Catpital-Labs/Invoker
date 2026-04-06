/**
 * ResponseHandler — Pure parser/validator for WorkResponse messages.
 *
 * No state machine access, no graph mutations. Parses the incoming
 * WorkResponse and returns a structured ParsedResponse that tells
 * the Orchestrator what writes to make.
 */

import type { WorkResponse } from '@invoker/contracts';
import { validateWorkResponse } from '@invoker/contracts';

/** Plan-local id segment for experiment id prefixing (strip `${workflowId}/` when present). */
function planLocalFromActionId(actionId: string): string {
  if (actionId.startsWith('__merge__')) {
    return actionId;
  }
  const i = actionId.indexOf('/');
  return i === -1 ? actionId : actionId.slice(i + 1);
}

// ── Parsed Response Types ───────────────────────────────────

export interface ParsedVariantDef {
  id: string;
  description: string;
  prompt?: string;
  command?: string;
}

export type ParsedResponse =
  | {
      type: 'completed';
      taskId: string;
      exitCode: number;
      summary?: string;
      commitHash?: string;
      agentSessionId?: string;
      branch?: string;
    }
  | {
      type: 'failed';
      taskId: string;
      exitCode: number;
      error?: string;
    }
  | {
      type: 'needs_input';
      taskId: string;
      prompt: string;
    }
  | {
      type: 'spawn_experiments';
      taskId: string;
      variants: ParsedVariantDef[];
    }
  | {
      type: 'select_experiment';
      taskId: string;
      experimentId: string;
    };

// ── Handler ─────────────────────────────────────────────────

export class ResponseHandler {
  /**
   * Parse and validate a WorkResponse into a structured result.
   * Returns the parsed data or an error. Does NOT mutate any state.
   */
  parseResponse(response: WorkResponse): ParsedResponse | { error: string } {
    const validation = validateWorkResponse(response);
    if (!validation.valid) {
      return { error: validation.error! };
    }

    const { actionId, status, outputs, dagMutation } = response;

    switch (status) {
      case 'completed':
        return {
          type: 'completed',
          taskId: actionId,
          exitCode: outputs.exitCode ?? 0,
          summary: outputs.summary,
          commitHash: outputs.commitHash,
          agentSessionId: outputs.agentSessionId,
          branch: outputs.branch,
        };

      case 'failed':
        return {
          type: 'failed',
          taskId: actionId,
          exitCode: outputs.exitCode ?? 1,
          error: outputs.error,
        };

      case 'needs_input':
        return {
          type: 'needs_input',
          taskId: actionId,
          prompt: outputs.summary ?? 'Task requires input',
        };

      case 'spawn_experiments': {
        if (!dagMutation?.spawnExperiments) {
          return { error: 'spawn_experiments requires dagMutation.spawnExperiments' };
        }
        const pivotLocal = planLocalFromActionId(actionId);
        const variants: ParsedVariantDef[] =
          dagMutation.spawnExperiments.variants.map((v) => ({
            id: `${pivotLocal}-exp-${v.id}`,
            description: v.description ?? `Experiment: ${v.id}`,
            prompt: v.prompt,
            command: v.command,
          }));
        return {
          type: 'spawn_experiments',
          taskId: actionId,
          variants,
        };
      }

      case 'select_experiment': {
        if (!dagMutation?.selectExperiment) {
          return { error: 'select_experiment requires dagMutation.selectExperiment' };
        }
        return {
          type: 'select_experiment',
          taskId: actionId,
          experimentId: dagMutation.selectExperiment.experimentId,
        };
      }

      default:
        return { error: `Unknown response status: ${status}` };
    }
  }
}
