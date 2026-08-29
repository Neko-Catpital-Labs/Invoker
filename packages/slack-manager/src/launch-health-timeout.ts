/**
 * A 300_000ms timeout was observed expiring while a live boot was still
 * running, and a separate successful boot took approximately 780 seconds.
 * 1_200_000ms provides real margin above both observed boot times.
 */
export const INVOKER_LAUNCH_HEALTH_TIMEOUT_MS = 1_200_000;
