export type WorkerControlChannel = 'invoker:start-worker' | 'invoker:stop-worker';

export interface WorkerControlMutation {
  readonly action: 'start' | 'stop';
  readonly channel: WorkerControlChannel;
  readonly kind: string;
}

export function resolveWorkerControlMutation(args: readonly string[]): WorkerControlMutation | null {
  if (args[0] !== 'worker') return null;
  const action = args[1];
  if (action !== 'start' && action !== 'stop') return null;
  const kind = args[2];
  if (!kind) {
    throw new Error(`Missing worker kind. Usage: --headless worker ${action} <kind>`);
  }
  return {
    action,
    channel: action === 'start' ? 'invoker:start-worker' : 'invoker:stop-worker',
    kind,
  };
}
