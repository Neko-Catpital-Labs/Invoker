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

/** Linear keys always forwarded from secretsFile when present (independent of useApiKey). */
export const LINEAR_ENV_KEYS = new Set([
  'LINEAR_API_KEY',
  'INVOKER_LINEAR_API_KEY',
]);

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function entriesFromSecretsFile(secretsFile: string | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const entry of loadSecretsFile(secretsFile)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    out.push([entry.slice(0, eq), entry.slice(eq + 1)]);
  }
  return out;
}

/**
 * Load Linear API keys from secretsFile whenever the file is set.
 * Independent of useApiKey so file-linear command tasks can run on any host.
 */
export function loadLinearEnv(secretsFile: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of entriesFromSecretsFile(secretsFile)) {
    if (!LINEAR_ENV_KEYS.has(key)) continue;
    env[key] = value;
  }
  return env;
}

export function loadRemoteAgentEnv(secretsFile: string | undefined, useApiKey: boolean): Record<string, string> {
  const env: Record<string, string> = { ...loadLinearEnv(secretsFile) };
  if (!useApiKey) return env;

  for (const [key, value] of entriesFromSecretsFile(secretsFile)) {
    if (!AGENT_ENV_KEYS.has(key)) continue;
    env[key] = value;
  }

  return env;
}

export function buildRemoteAgentEnvExports(secretsFile: string | undefined, useApiKey: boolean): string {
  const entries = Object.entries(loadRemoteAgentEnv(secretsFile, useApiKey));
  if (entries.length === 0) return '';
  return entries
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n') + '\n';
}
