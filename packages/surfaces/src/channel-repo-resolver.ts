import { extractRepoUrlFromText } from '@invoker/slack-bug-scan/repo-url';
import type { LogFn } from './surface.js';

export const CHANNEL_REPO_SOURCE_PRECEDENCE = ['config', 'binding', 'topic', 'purpose'] as const;

export type ChannelRepoSource = (typeof CHANNEL_REPO_SOURCE_PRECEDENCE)[number];

export interface ChannelRepoKey {
  surface: string;
  channelId: string;
}

type LookupResult = string | undefined;

export type ChannelRepoLookup = (key: ChannelRepoKey) => LookupResult | Promise<LookupResult>;

export interface ChannelRepoLookups {
  configBinding?: ChannelRepoLookup;
  persistedBinding?: ChannelRepoLookup;
  channelTopic?: ChannelRepoLookup;
  channelPurpose?: ChannelRepoLookup;
  normalizeRepoUrl?: (raw: string) => string;
  sameRepoUrl?: (a: string, b: string) => boolean;
  log?: LogFn;
}

export interface ChannelRepoCandidate {
  source: ChannelRepoSource;
  repoUrl: string;
}

export interface ChannelRepoResolution {
  repoUrl?: string;
  source?: ChannelRepoSource;
  candidates: ChannelRepoCandidate[];
  conflict: boolean;
}

const URL_BEARING_TEXT_SOURCES: ReadonlySet<ChannelRepoSource> = new Set<ChannelRepoSource>(['topic', 'purpose']);

function defaultNormalizeRepoUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function defaultSameRepoUrl(a: string, b: string): boolean {
  return a === b;
}

function lookupFor(lookups: ChannelRepoLookups, source: ChannelRepoSource): ChannelRepoLookup | undefined {
  switch (source) {
    case 'config': return lookups.configBinding;
    case 'binding': return lookups.persistedBinding;
    case 'topic': return lookups.channelTopic;
    case 'purpose': return lookups.channelPurpose;
  }
}

function describeCandidates(candidates: ChannelRepoCandidate[]): string {
  return candidates.map((candidate) => `${candidate.source}=${candidate.repoUrl}`).join(', ');
}

function formatConflict(key: ChannelRepoKey, winner: ChannelRepoCandidate, candidates: ChannelRepoCandidate[]): string {
  return `[CHANNEL_REPO_CONFLICT] channel=${key.channelId} sources disagree; `
    + `using ${winner.source}=${winner.repoUrl} `
    + `(precedence ${CHANNEL_REPO_SOURCE_PRECEDENCE.join(' > ')}); `
    + `all sources: ${describeCandidates(candidates)}`;
}

export async function resolveChannelRepo(
  key: { surface: string; channelId?: string },
  lookups: ChannelRepoLookups,
): Promise<ChannelRepoResolution> {
  if (!key.channelId) return { candidates: [], conflict: false };

  const resolvedKey: ChannelRepoKey = { surface: key.surface, channelId: key.channelId };
  const normalizeRepoUrl = lookups.normalizeRepoUrl ?? defaultNormalizeRepoUrl;
  const sameRepoUrl = lookups.sameRepoUrl ?? defaultSameRepoUrl;
  const candidates: ChannelRepoCandidate[] = [];

  for (const source of CHANNEL_REPO_SOURCE_PRECEDENCE) {
    const lookup = lookupFor(lookups, source);
    if (!lookup) continue;
    let raw: LookupResult;
    try {
      raw = await lookup(resolvedKey);
    } catch {
      raw = undefined;
    }
    const value = URL_BEARING_TEXT_SOURCES.has(source) ? extractRepoUrlFromText(raw) : raw?.trim() || undefined;
    if (!value) continue;
    candidates.push({ source, repoUrl: normalizeRepoUrl(value) });
  }

  const winner = candidates[0];
  if (!winner) return { candidates, conflict: false };

  const conflict = candidates.some((candidate) => !sameRepoUrl(candidate.repoUrl, winner.repoUrl));
  if (conflict) lookups.log?.(key.surface, 'warn', formatConflict(resolvedKey, winner, candidates));

  return { repoUrl: winner.repoUrl, source: winner.source, candidates, conflict };
}
