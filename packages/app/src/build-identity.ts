declare const __BUILD_SHA__: string | undefined;
declare const __BUILD_VERSION__: string | undefined;

export interface BuildIdentity {
  version: string;
  sha: string;
}

/**
 * The identity of the code actually running in this process, stamped in at
 * build time by tsup (see tsup.config.ts). Outside a real build (vitest,
 * ts-node) the constants are never substituted, so `sha` reads 'dev' — the
 * signal that no reliable cross-process comparison is possible here.
 */
export function currentBuildIdentity(): BuildIdentity {
  return {
    version: typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'dev',
    sha: typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev',
  };
}

/**
 * Whether a remote process (an "owner" discovered over the message bus) is
 * running code incompatible with this one. Returns a human-readable reason
 * when incompatible, `null` when safe to delegate to.
 *
 * `local.sha === 'dev'` means this process didn't go through the tsup build
 * (a test runner, ts-node) and can't reliably compare — skip the check
 * rather than risk a false positive.
 */
export function describeBuildMismatch(local: BuildIdentity, remote: BuildIdentity): string | null {
  if (local.sha === 'dev') return null;
  if (remote.sha === local.sha) return null;
  const remoteDescription = remote.sha
    ? `${remote.version || 'an unknown version'} (${remote.sha})`
    : 'a build that predates this compatibility check';
  return `Owner process is running ${remoteDescription}, but this process is ${local.version} (${local.sha}). `
    + 'Mismatched builds cannot safely delegate to each other — stop the other Invoker process and relaunch.';
}
