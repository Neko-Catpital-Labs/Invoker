export type WorkerControlChannel =
  | 'invoker:start-worker'
  | 'invoker:stop-worker'
  | 'invoker:tick-worker';

export interface WorkerControlMutation {
  readonly action: 'start' | 'stop' | 'tick';
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
  const channel: WorkerControlChannel =
    action === 'start' ? 'invoker:start-worker'
    : action === 'stop' ? 'invoker:stop-worker'
    : 'invoker:tick-worker';
  return {
    action,
    channel,
    kind,
  };
}
