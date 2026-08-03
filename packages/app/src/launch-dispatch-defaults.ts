/**
 * Test-only override for DISPATCH_LEASE_MS / LAUNCH_STUCK_ABANDON_MS (both
 * 12 minutes in production, see @invoker/contracts launch-timeouts.ts).
 * Lets e2e tests exercise the stuck-launch reaper in seconds instead of
 * real minutes, the same way INVOKER_EXECUTING_STALL_TIMEOUT_MS does for
 * the separate executing-stall watchdog.
 */
export function resolveLaunchDispatchLeaseMsOverride(): number | undefined {
  const raw = process.env.INVOKER_LAUNCH_DISPATCH_LEASE_MS;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
