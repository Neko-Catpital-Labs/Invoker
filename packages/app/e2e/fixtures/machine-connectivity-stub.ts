import {
  REMOTE_TARGET_CONNECTIVITY_STUB_ENV_VAR,
  type RemoteTargetConnectivityResult,
} from '@invoker/contracts';

export function stubMachineConnectivity(host: string, outcome: RemoteTargetConnectivityResult): void {
  const raw = process.env[REMOTE_TARGET_CONNECTIVITY_STUB_ENV_VAR];
  const scripted = raw ? JSON.parse(raw) : {};
  process.env[REMOTE_TARGET_CONNECTIVITY_STUB_ENV_VAR] = JSON.stringify({ ...scripted, [host]: outcome });
}

export function clearMachineConnectivityStub(): void {
  delete process.env[REMOTE_TARGET_CONNECTIVITY_STUB_ENV_VAR];
}
