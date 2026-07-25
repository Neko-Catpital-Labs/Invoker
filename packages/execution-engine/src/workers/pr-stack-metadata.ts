import type { PullRequestIssueComment } from './pr-maintenance-github.js';

const STACK_MARKER_RE = /<!--\s*mergify-stack-data:\s*(\{[\s\S]*?\})\s*-->/;

type StackMetadataPull = {
  number: number;
  headSha?: string;
  baseBranch?: string;
  headRefName?: string;
  isCurrent?: boolean;
};

type LatestMarker = {
  updatedAt: string;
  metadata: {
    stackId: string;
    pulls: StackMetadataPull[];
  };
};

type ResolvedPullRequest = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
};

export function parseMergifyStackMetadata(comments: readonly PullRequestIssueComment[]): {
  stackId: string;
  pulls: Array<{
    number: number;
    headSha?: string;
    baseBranch?: string;
    headRefName?: string;
    isCurrent?: boolean;
  }>;
} | undefined {
  return latestMarkerFromComments(comments)?.metadata;
}

export function resolveCurrentPullRequestStack(
  openPrs: readonly Array<{
    number: number;
    title?: string;
    url?: string;
    headRefName?: string;
    headRefOid?: string;
    baseRefName?: string;
  }>,
  commentsByPr: ReadonlyMap<number, readonly PullRequestIssueComment[]>,
  currentPrNumber: number,
  trunk: string,
): {
  stackId: string;
  pulls: Array<{
    number: number;
    title: string;
    url: string;
    headRefName: string;
    headRefOid: string;
    baseRefName: string;
  }>;
} {
  const prsByNumber = new Map<number, ResolvedPullRequest>();
  const prsByHeadRef = new Map<string, ResolvedPullRequest[]>();
  const prsByBaseRef = new Map<string, ResolvedPullRequest[]>();

  for (const pullRequest of openPrs) {
    const number = toPrNumber(pullRequest.number);
    if (number === undefined) continue;
    const normalized: ResolvedPullRequest = {
      number,
      title: normalizeTitle(pullRequest.title, number),
      url: normalizeString(pullRequest.url) ?? '',
      headRefName: normalizeString(pullRequest.headRefName) ?? '',
      headRefOid: normalizeString(pullRequest.headRefOid) ?? '',
      baseRefName: normalizeString(pullRequest.baseRefName) ?? '',
    };
    prsByNumber.set(number, normalized);
  }

  for (const pullRequest of prsByNumber.values()) {
    if (pullRequest.headRefName) {
      const existing = prsByHeadRef.get(pullRequest.headRefName) ?? [];
      existing.push(pullRequest);
      prsByHeadRef.set(pullRequest.headRefName, existing);
    }
    const existing = prsByBaseRef.get(pullRequest.baseRefName) ?? [];
    existing.push(pullRequest);
    prsByBaseRef.set(pullRequest.baseRefName, existing);
  }

  const currentPullRequest = prsByNumber.get(currentPrNumber) ?? {
    number: currentPrNumber,
    title: `PR #${currentPrNumber}`,
    url: '',
    headRefName: '',
    headRefOid: '',
    baseRefName: trunk,
  };

  const marker = latestMarkerForCurrentPullRequest(commentsByPr, currentPrNumber);
  if (marker) {
    const pulls = marker.pulls
      .map((pull) => prsByNumber.get(pull.number))
      .filter((pull): pull is ResolvedPullRequest => pull !== undefined);
    if (pulls.some((pull) => pull.number === currentPrNumber)) {
      return { stackId: marker.stackId, pulls };
    }
  }

  const chainRoot = resolveChainRoot(currentPullRequest, prsByHeadRef);
  const chain = resolveChainFromRoot(chainRoot, prsByBaseRef);
  if (chain.length > 1) {
    return { stackId: `branch:${chain[0]!.number}`, pulls: chain };
  }
  return { stackId: `single:${currentPullRequest.number}`, pulls: [currentPullRequest] };
}

function latestMarkerForCurrentPullRequest(
  commentsByPr: ReadonlyMap<number, readonly PullRequestIssueComment[]>,
  currentPrNumber: number,
): LatestMarker['metadata'] | undefined {
  const candidates: LatestMarker[] = [];
  for (const comments of commentsByPr.values()) {
    const marker = latestMarkerFromComments(comments);
    if (!marker) continue;
    if (marker.metadata.pulls.some((pull) => pull.number === currentPrNumber)) {
      candidates.push(marker);
    }
  }
  candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return candidates[0]?.metadata;
}

function latestMarkerFromComments(comments: readonly PullRequestIssueComment[]): LatestMarker | undefined {
  const ordered = [...comments].sort((left, right) => {
    const leftUpdatedAt = normalizeString(left.updatedAt) ?? '';
    const rightUpdatedAt = normalizeString(right.updatedAt) ?? '';
    return rightUpdatedAt.localeCompare(leftUpdatedAt);
  });
  for (const comment of ordered) {
    const match = STACK_MARKER_RE.exec(comment.body);
    if (!match?.[1]) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(match[1]) as Record<string, unknown>;
    } catch {
      continue;
    }
    const stackId = firstString(payload.stack_id, payload.stackId, payload.id);
    const pulls = normalizeMarkerPulls(
      payload.pull_numbers_bottom_to_top
      ?? payload.pullNumbersBottomToTop
      ?? payload.prs
      ?? payload.pulls,
    );
    if (!stackId || !pulls) continue;
    return {
      updatedAt: normalizeString(comment.updatedAt) ?? '',
      metadata: { stackId, pulls },
    };
  }
  return undefined;
}

function normalizeMarkerPulls(value: unknown): StackMetadataPull[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const pulls: StackMetadataPull[] = [];
  for (const item of value) {
    if (typeof item === 'object' && item !== null) {
      const record = item as Record<string, unknown>;
      const number = toPrNumber(record.number);
      if (number === undefined) return undefined;
      const pull: StackMetadataPull = { number };
      const headSha = firstString(record.head_sha, record.headSha);
      const baseBranch = firstString(record.base_branch, record.baseBranch);
      const headRefName = firstString(record.head_ref_name, record.headRefName);
      const isCurrent = toBoolean(record.is_current ?? record.isCurrent);
      if (headSha) pull.headSha = headSha;
      if (baseBranch) pull.baseBranch = baseBranch;
      if (headRefName) pull.headRefName = headRefName;
      if (isCurrent !== undefined) pull.isCurrent = isCurrent;
      pulls.push(pull);
      continue;
    }

    const number = toPrNumber(item);
    if (number === undefined) return undefined;
    pulls.push({ number });
  }
  return pulls;
}

function resolveChainRoot(
  currentPullRequest: ResolvedPullRequest,
  prsByHeadRef: ReadonlyMap<string, readonly ResolvedPullRequest[]>,
): ResolvedPullRequest {
  const visited = new Set<number>([currentPullRequest.number]);
  let root = currentPullRequest;
  while (root.baseRefName) {
    const parents = prsByHeadRef.get(root.baseRefName) ?? [];
    if (parents.length !== 1) break;
    const [parent] = parents;
    if (!parent || visited.has(parent.number)) break;
    visited.add(parent.number);
    root = parent;
  }
  return root;
}

function resolveChainFromRoot(
  root: ResolvedPullRequest,
  prsByBaseRef: ReadonlyMap<string, readonly ResolvedPullRequest[]>,
): ResolvedPullRequest[] {
  const stack = [root];
  const used = new Set<number>([root.number]);
  let top = root;
  while (top.headRefName) {
    const children = (prsByBaseRef.get(top.headRefName) ?? []).filter((child) => !used.has(child.number));
    if (children.length !== 1) break;
    const [child] = children;
    if (!child) break;
    stack.push(child);
    used.add(child.number);
    top = child;
  }
  return stack;
}

function normalizeTitle(value: string | undefined, prNumber: number): string {
  const title = normalizeString(value);
  return title && title.length > 0 ? title : `PR #${prNumber}`;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function toPrNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
