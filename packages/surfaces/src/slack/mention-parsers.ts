import type { PlanningConfirmationMode } from '@invoker/planning-core';

export type LocalRequest =
  | { kind: 'command'; text: string }
  | { kind: 'agent'; text: string }
  | { kind: 'change'; text: string };

export const PRESET_TOOL_HINTS = ['cursor', 'omp', 'codex', 'claude'];
export const MESSAGE_REPO_TOKEN_RE = /<((?:https?|ssh):\/\/[^|>\s]+|git@[\w.-]+:[^|>\s]+)(?:\|[^>]+)?>|\b(?:https?:\/\/[^\s<>()\[\]{}"'|]+|ssh:\/\/[^\s<>()\[\]{}"'|]+|git@[\w.-]+:[^\s<>()\[\]{}"'|]+)/gi;
export const TRAILING_URL_PUNCTUATION = new Set(['.', ',', ';', ':', '!']);
export const GITHUB_REPO_ROOT_PATH_RE = /^\/[^/]+\/[^/]+(?:\.git)?\/?$/;
export const CHANNEL_REPO_SETUP_INTENT_RE = /\b(?:set\s*up|setup|configure|map|bind)\b/i;
export const CHANNEL_REPO_PAIR_RE = /#([A-Za-z0-9][A-Za-z0-9_-]{0,79})\s*(?:(?:=>|->|=|:|\bto\b|\bfor\b|\brepo(?:sitory)?\b)\s*)?(<((?:https?|ssh):\/\/[^|>\s]+|git@[\w.-]+:[^|>\s]+)(?:\|[^>]+)?>|\b(?:https?:\/\/[^\s<>()\[\]{}"'|]+|ssh:\/\/[^\s<>()\[\]{}"'|]+|git@[\w.-]+:[^\s<>()\[\]{}"'|]+))/gi;

export function looksLikePreset(normalized: string): boolean {
  return normalized.includes('+') || PRESET_TOOL_HINTS.some((hint) => normalized.includes(hint));
}

export function extractRepoUrlFromMessage(text: string): string | undefined {
  return extractMessageRepoCandidates(text)[0];
}

export function parsePlanningRequest(
  text: string,
  presetKeys: string[],
  defaultPresetKey: string,
): {
  presetKey: string;
  repo?: string;
  repositoryUrls?: string[];
  hasExplicitPreset?: boolean;
  confirmationMode?: PlanningConfirmationMode;
  autoSubmitRequested?: boolean;
  text: string;
  unknownPreset?: string;
} {
  let rest = text.replace(/<@[^>]+>/g, '').trim();
  let presetKey = defaultPresetKey;
  let repo: string | undefined;
  let confirmationMode: PlanningConfirmationMode | undefined;
  let autoSubmitRequested = false;
  let unknownPreset: string | undefined;
  let hasExplicitPreset = false;
  const keyset = new Set(presetKeys.map((k) => k.toLowerCase()));
  const tagRe = /^\[([^\]]*)\]\s*/;

  for (;;) {
    const m = tagRe.exec(rest);
    if (!m) break;
    const raw = m[1].trim();
    if (/^repo:/i.test(raw)) {
      repo = raw.slice(raw.indexOf(':') + 1).trim();
      rest = rest.slice(m[0].length);
      continue;
    }
    const normalized = raw.toLowerCase().replace(/\s+/g, '').replace(/^plain/, '');
    if (normalized === 'auto-submit' || normalized === 'autosubmit') {
      confirmationMode = 'require';
      autoSubmitRequested = true;
      rest = rest.slice(m[0].length);
      continue;
    }
    if (keyset.has(normalized)) {
      presetKey = normalized;
      hasExplicitPreset = true;
      rest = rest.slice(m[0].length);
      continue;
    }
    if (looksLikePreset(normalized)) {
      unknownPreset = raw;
      rest = rest.slice(m[0].length);
    }
    break;
  }

  const repositoryUrls = extractRepositoryUrls(rest);
  return {
    presetKey,
    repo,
    text: rest.trim(),
    ...(repositoryUrls.length > 0 ? { repositoryUrls } : {}),
    ...(hasExplicitPreset ? { hasExplicitPreset } : {}),
    ...(confirmationMode ? { confirmationMode } : {}),
    ...(autoSubmitRequested ? { autoSubmitRequested } : {}),
    ...(unknownPreset ? { unknownPreset } : {}),
  };
}

export function extractRepositoryUrls(text: string): string[] {
  return extractMessageRepoCandidates(text);
}

export function extractMessageRepoCandidates(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MESSAGE_REPO_TOKEN_RE)) {
    let candidate = (match[1] ?? match[0]).trim();
    while (candidate && TRAILING_URL_PUNCTUATION.has(candidate.at(-1)!)) {
      candidate = candidate.slice(0, -1);
    }

    const accepted = normalizeSupportedRepoCandidate(candidate);

    if (accepted && !seen.has(accepted)) {
      seen.add(accepted);
      urls.push(accepted);
    }
  }
  return urls;
}

export function normalizeSupportedRepoCandidate(candidate: string): string | undefined {
  if (/^git@[\w.-]+:.+/.test(candidate)) return candidate;
  if (/^ssh:\/\//i.test(candidate)) return candidate;
  if (!/^https?:\/\//i.test(candidate) || /[?#]/.test(candidate)) return undefined;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (!url.host || url.username || url.password || url.search || url.hash) return undefined;

  const host = url.host.toLowerCase();
  if (host === 'github.com') {
    return GITHUB_REPO_ROOT_PATH_RE.test(url.pathname)
      ? candidate.replace(/\/$/, '')
      : undefined;
  }
  return url.pathname.endsWith('.git') ? candidate : undefined;
}

export function normalizePublicChannelName(name: string): string {
  return name.trim().replace(/^#/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export function parseWorkflowStatusQuery(text: string): { intent: 'command'; operation: 'status'; target: { all: true } } | null {
  const trimmed = text.trim();
  if (/\n/.test(trimmed)) return null;
  if (trimmed.split(/\s+/).length > 12) return null;
  if (!/\bworkflows?\b/i.test(trimmed)) return null;
  if (!/\b(status|how many|count|running|active|in progress|progress)\b/i.test(trimmed)) return null;
  return { intent: 'command', operation: 'status', target: { all: true } };
}

export function parseLocalRequest(text: string): LocalRequest | null {
  const trimmed = text.trim();
  const commandPatterns = [
    /^(?:exec|execute)\s+local(?:ly)?\s*:\s*/i,
    /^local\s+(?:command|cmd)\s*:\s*/i,
  ];
  for (const pattern of commandPatterns) {
    const match = pattern.exec(trimmed);
    if (match) {
      const rest = trimmed.slice(match[0].length).trim();
      return rest ? { kind: 'command', text: rest } : null;
    }
  }

  const agentPatterns = [
    /^run\s+local(?:ly)?\s*:\s*/i,
    /^local\s+run\s*:\s*/i,
  ];
  for (const pattern of agentPatterns) {
    const match = pattern.exec(trimmed);
    if (match) {
      const rest = trimmed.slice(match[0].length).trim();
      return rest ? { kind: 'agent', text: rest } : null;
    }
  }

  const changePatterns = [
    /^local\s*:\s*/i,
    /^local\s+(?:change|edit|patch)\s*:\s*/i,
    /^(?:change|edit|patch)\s+local(?:ly)?\s*:\s*/i,
    /^locally\s*:\s*/i,
  ];
  for (const pattern of changePatterns) {
    const match = pattern.exec(trimmed);
    if (match) {
      const rest = trimmed.slice(match[0].length).trim();
      return rest ? { kind: 'change', text: rest } : null;
    }
  }

  return null;
}
