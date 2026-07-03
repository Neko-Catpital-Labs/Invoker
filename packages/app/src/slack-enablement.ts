/**
 * Helpers that decide whether this process should bring the Slack surface online.
 */

/**
 * Whether the Slack surface must stay offline because this process is a test/e2e
 * instance. Prevents test apps (which inherit real Slack creds from the shared
 * `~/.invoker/.env`) from joining the production workspace and stealing events.
 */
export function slackDisabledForTests(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test' || env.INVOKER_DISABLE_SLACK === '1';
}
