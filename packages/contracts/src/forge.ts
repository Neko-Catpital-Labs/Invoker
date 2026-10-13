export type ForgeKind = 'github' | 'gitlab';

export interface ForgeProject {
  readonly kind: ForgeKind;
  readonly host: string;
  readonly projectPath: string;
  readonly reviewId?: string;
  readonly jobId?: string;
  readonly pipelineId?: string;
  readonly runId?: string;
}

export interface MergeGateProviderResult {
  url: string;
  identifier: string;
}

export interface MergeGateCreateReviewOptions {
  baseBranch: string;
  featureBranch: string;
  title: string;
  cwd: string;
  body?: string;
}

export interface MergeGateCheckApprovalOptions {
  identifier: string;
  cwd: string;
}

export interface MergeGateCloseReviewOptions {
  identifier: string;
  cwd: string;
}

export interface MergeGateUpdateReviewBodyOptions {
  identifier: string;
  cwd: string;
  body: string;
}

export interface MergeGateCheckSummary {
  state: 'pending' | 'success' | 'failure';
  failed: MergeGateFailedCheck[];
}

export type MergeGatePrLifecycle = 'open' | 'closed' | 'merged';

export interface MergeGateApprovalStatus {
  lifecycle: MergeGatePrLifecycle;
  rejected: boolean;
  statusText: string;
  url: string;
  headSha?: string;
  headRef?: string;
  mergeState?: 'clean' | 'dirty' | 'unknown';
  hasMergeConflict?: boolean;
  checks?: MergeGateCheckSummary;
}

export interface MergeGateFailedCheck {
  name: string;
  conclusion?: string;
  detailsUrl?: string;
  summary?: string;
}

export interface ForgeOpenReview {
  readonly number: number;
  readonly state: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly url?: string;
}

export interface ForgeListOpenReviewsOptions {
  readonly projectPath: string;
  readonly cwd: string;
}

export interface ForgeFetchFailedJobLogOptions {
  readonly detailsUrl: string;
  readonly cwd: string;
}

export interface ForgeProvider {
  readonly name: ForgeKind;

  createReview(opts: MergeGateCreateReviewOptions): Promise<MergeGateProviderResult>;

  checkApproval(opts: MergeGateCheckApprovalOptions): Promise<MergeGateApprovalStatus>;

  closeReview?(opts: MergeGateCloseReviewOptions): Promise<void>;

  getReviewBody?(opts: { identifier: string; cwd: string }): Promise<string>;

  updateReviewBody?(opts: MergeGateUpdateReviewBodyOptions): Promise<void>;

  listOpenReviews?(opts: ForgeListOpenReviewsOptions): Promise<ForgeOpenReview[]>;

  fetchFailedJobLog?(opts: ForgeFetchFailedJobLogOptions): Promise<string | undefined>;
}

export type MergeGateProvider = ForgeProvider;

const GITHUB_HOST = 'github.com';
const DEFAULT_GITLAB_HOST = 'gitlab.com';

function stripGitSuffix(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end -= 1;
  const withoutTrailingSlashes = path.slice(0, end);
  return withoutTrailingSlashes.toLowerCase().endsWith('.git')
    ? withoutTrailingSlashes.slice(0, -4)
    : withoutTrailingSlashes;
}

function stripLeadingSlashes(path: string): string {
  let start = 0;
  while (start < path.length && path[start] === '/') start += 1;
  return path.slice(start);
}

function stripHttpProtocol(value: string): string {
  const lower = value.toLowerCase();
  if (lower.startsWith('https://')) return value.slice('https://'.length);
  if (lower.startsWith('http://')) return value.slice('http://'.length);
  return value;
}

function gitlabHostsFromEnv(): Set<string> {
  const hosts = new Set<string>([DEFAULT_GITLAB_HOST]);
  const raw = process.env.INVOKER_GITLAB_HOST?.trim();
  if (!raw) return hosts;
  for (const part of raw.split(',')) {
    const host = stripGitSuffix(stripHttpProtocol(part.trim())).toLowerCase();
    if (host) hosts.add(host);
  }
  return hosts;
}

function hostWithoutPort(host: string): string {
  const portSeparator = host.lastIndexOf(':');
  if (portSeparator < 0) return host;
  const maybePort = host.slice(portSeparator + 1);
  return isDecimalId(maybePort) ? host.slice(0, portSeparator) : host;
}

function parseScpOrUrl(raw: string): { host: string; pathname: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const scpPrefix = 'git@';
  if (trimmed.toLowerCase().startsWith(scpPrefix)) {
    const rest = trimmed.slice(scpPrefix.length);
    const separator = rest.indexOf(':');
    if (separator > 0 && separator < rest.length - 1) {
      return { host: rest.slice(0, separator).toLowerCase(), pathname: rest.slice(separator + 1) };
    }
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    if (!parsed.host || !['http:', 'https:', 'ssh:'].includes(parsed.protocol)) return undefined;
    if (parsed.search || parsed.hash) return undefined;
    const pathname = stripLeadingSlashes(parsed.pathname);
    if (!pathname) return undefined;
    return { host: parsed.host.toLowerCase(), pathname };
  } catch {
    return undefined;
  }
}

function parseGitHubProject(host: string, pathname: string): ForgeProject | undefined {
  const segments = stripGitSuffix(pathname).split('/').filter(Boolean);
  const owner = segments[0];
  const repo = segments[1] ? stripGitSuffix(segments[1]) : undefined;
  if (!owner || !repo) return undefined;

  if (segments[2] === 'pull' && isDecimalId(segments[3] ?? '')) {
    return {
      kind: 'github',
      host,
      projectPath: `${owner}/${repo}`.toLowerCase(),
      reviewId: segments[3],
    };
  }

  if (segments[2] === 'actions' && segments[3] === 'runs' && isDecimalId(segments[4] ?? '')) {
    const jobId = githubActionsJobId(segments.slice(5));
    return {
      kind: 'github',
      host,
      projectPath: `${owner}/${repo}`.toLowerCase(),
      runId: segments[4],
      ...(jobId ? { jobId } : {}),
    };
  }

  if (segments.length === 2) {
    return {
      kind: 'github',
      host,
      projectPath: `${owner}/${repo}`.toLowerCase(),
    };
  }

  return undefined;
}

function githubActionsJobId(segments: string[]): string | undefined {
  if (segments[0] === 'job' || segments[0] === 'jobs') {
    return isDecimalId(segments[1] ?? '') ? segments[1] : undefined;
  }
  if (segments[0] === 'attempts' && isDecimalId(segments[1] ?? '')) {
    const label = segments[2];
    if (label === 'job' || label === 'jobs') {
      return isDecimalId(segments[3] ?? '') ? segments[3] : undefined;
    }
  }
  return undefined;
}

function parseGitLabProject(host: string, pathname: string): ForgeProject | undefined {
  const trimmedPath = stripGitSuffix(pathname);
  const segments = trimmedPath.split('/');
  const sentinelIndex = segments.indexOf('-');
  if (sentinelIndex >= 0) {
    const projectPath = stripGitSuffix(segments.slice(0, sentinelIndex).join('/'));
    if (projectPath.split('/').filter(Boolean).length < 2) return undefined;

    const kind = segments[sentinelIndex + 1];
    const id = segments[sentinelIndex + 2];
    if (!id || !isDecimalId(id)) return undefined;
    if (kind === 'merge_requests') {
      return {
        kind: 'gitlab',
        host,
        projectPath,
        reviewId: id,
      };
    }
    if (kind === 'jobs') {
      return {
        kind: 'gitlab',
        host,
        projectPath,
        jobId: id,
      };
    }
    if (kind === 'pipelines') {
      return {
        kind: 'gitlab',
        host,
        projectPath,
        pipelineId: id,
      };
    }
    return undefined;
  }

  const projectPath = stripGitSuffix(pathname);
  if (projectPath.split('/').filter(Boolean).length < 2) return undefined;
  return {
    kind: 'gitlab',
    host,
    projectPath,
  };
}

function isDecimalId(value: string): boolean {
  if (!value) return false;
  for (const char of value) {
    if (char < '0' || char > '9') return false;
  }
  return true;
}

export function parseForgeProject(url: string): ForgeProject | undefined {
  const parts = parseScpOrUrl(url);
  if (!parts) return undefined;

  if (parts.host === GITHUB_HOST || parts.host === `www.${GITHUB_HOST}`) {
    return parseGitHubProject(GITHUB_HOST, parts.pathname);
  }

  const gitlabHosts = gitlabHostsFromEnv();
  if (gitlabHosts.has(parts.host) || gitlabHosts.has(hostWithoutPort(parts.host))) {
    return parseGitLabProject(parts.host, parts.pathname);
  }

  return undefined;
}

export function forgeProjectIdentity(project: ForgeProject): string {
  return `${project.kind}:${project.host}/${project.projectPath}`;
}

export function forgeProjectIdentityFromUrl(url: string): string | undefined {
  const project = parseForgeProject(url);
  return project ? forgeProjectIdentity(project) : undefined;
}
