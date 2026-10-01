import type { Logger } from '@invoker/contracts';

export type HeadlessRunAck = { workflowId: string; planName: string };

export function acceptHeadlessRunAck<T extends HeadlessRunAck>(
  result: T,
  mode: 'standalone' | 'gui',
  log: Logger,
): T {
  if (!result.workflowId) {
    const reason = `plan "${result.planName}" produced no persisted workflow id`;
    log.error(`headless.run rejected mode=${mode} ${reason}`, { module: 'ipc-delegate' });
    throw new Error(`headless.run failed: ${reason}`);
  }
  return result;
}
