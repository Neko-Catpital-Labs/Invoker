import { loadSecretsFile } from './secrets-loader.js';

const AGENT_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENROUTER_API_KEY',
  'BAILIAN_CODING_PLAN_API_KEY',
  'DASHSCOPE_API_KEY',
  'QWEN_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
]);

const GITHUB_CLI_ENV_KEYS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
]);

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function loadRemoteAgentEnv(
  secretsFile: string | undefined,
  useApiKey: boolean,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};

  // GitHub CLI auth is command/tool auth, so SSH command tasks need it even
  // when agent-provider API key forwarding is disabled.
  for (const key of GITHUB_CLI_ENV_KEYS) {
    const value = sourceEnv[key];
    if (value) env[key] = value;
  }

  for (const entry of loadSecretsFile(secretsFile)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (!GITHUB_CLI_ENV_KEYS.has(key) && !(useApiKey && AGENT_ENV_KEYS.has(key))) continue;
    env[key] = entry.slice(eq + 1);
  }

  return env;
}

export function buildRemoteAgentEnvExports(
  secretsFile: string | undefined,
  useApiKey: boolean,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): string {
  const entries = Object.entries(loadRemoteAgentEnv(secretsFile, useApiKey, sourceEnv));
  if (entries.length === 0) return '';
  return entries
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n') + '\n';
}
