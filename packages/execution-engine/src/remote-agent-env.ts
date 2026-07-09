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

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function loadRemoteAgentEnv(secretsFile: string | undefined, useApiKey: boolean): Record<string, string> {
  if (!useApiKey) return {};

  const env: Record<string, string> = {};
  for (const entry of loadSecretsFile(secretsFile)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (!AGENT_ENV_KEYS.has(key)) continue;
    env[key] = entry.slice(eq + 1);
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
