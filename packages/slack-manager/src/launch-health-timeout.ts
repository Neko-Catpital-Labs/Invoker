// invoker.db passed 1 GB in production, so a cold boot can outlast the old 90s default before the owner's IPC handler registers.
export const INVOKER_LAUNCH_HEALTH_TIMEOUT_MS = 300_000;
