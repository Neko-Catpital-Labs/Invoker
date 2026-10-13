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
  const withoutTrailingSlashes = trimTrailingSlashes(path);
  return withoutTrailingSlashes.toLowerCase().endsWith('.git')
    ? withoutTrailingSlashes.slice(0, -'.git'.length)
    : withoutTrailingSlashes;
}

function gitlabHostsFromEnv(): Set<string> {
  const hosts = new Set<string>([DEFAULT_GITLAB_HOST]);
  const raw = process.env.INVOKER_GITLAB_HOST?.trim();
  if (!raw) return hosts;
  for (const part of raw.split(',')) {
    const normalized = stripHttpScheme(part.trim().toLowerCase());
    const host = trimTrailingSlashes(normalized);
    if (host) hosts.add(host);
  }
  return hosts;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function stripHttpScheme(value: string): string {
  if (value.startsWith('https://')) return value.slice('https://'.length);
  if (value.startsWith('http://')) return value.slice('http://'.length);
  return value;
}

function hostWithoutPort(host: string): string {
  const colonIndex = host.lastIndexOf(':');
  if (colonIndex === -1) return host;
  const maybePort = host.slice(colonIndex + 1);
  return isDecimal(maybePort) ? host.slice(0, colonIndex) : host;
}

function parseScpOrUrl(raw: string): { host: string; pathname: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  if (trimmed.toLowerCase().startsWith('git@')) {
    const separatorIndex = trimmed.indexOf(':', 'git@'.length);
    if (separatorIndex > 'git@'.length && separatorIndex < trimmed.length - 1) {
      return {
        host: trimmed.slice('git@'.length, separatorIndex).toLowerCase(),
        pathname: trimmed.slice(separatorIndex + 1),
      };
    }
  }

  try {
    const parsed = new URL(trimmed);
    if (!parsed.host || !['http:', 'https:', 'ssh:'].includes(parsed.protocol)) return undefined;
    if (parsed.search || parsed.hash) return undefined;
    const pathname = trimLeadingSlashes(parsed.pathname);
    if (!pathname) return undefined;
    return { host: parsed.host.toLowerCase(), pathname };
  } catch {
    return undefined;
  }
}

function parseGitHubProject(host: string, pathname: string): ForgeProject | undefined {
  const segments = trimTrailingSlashes(pathname).split('/').filter(Boolean);
  const projectPath = parseGitHubProjectPathSegments(segments);
  if (!projectPath) return undefined;

  if (segments.length >= 4 && segments[2].toLowerCase() === 'pull' && isDecimal(segments[3])) {
    return {
      kind: 'github',
      host,
      projectPath,
      reviewId: segments[3],
    };
  }

  if (
    segments.length >= 5
    && segments[2].toLowerCase() === 'actions'
    && segments[3].toLowerCase() === 'runs'
    && isDecimal(segments[4])
  ) {
    const jobId = parseGitHubActionsJobId(segments);
    return {
      kind: 'github',
      host,
      projectPath,
      runId: segments[4],
      ...(jobId ? { jobId } : {}),
    };
  }

  if (segments.length === 2) {
    return {
      kind: 'github',
      host,
      projectPath,
    };
  }

  return undefined;
}

function trimLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) === 47) start += 1;
  return value.slice(start);
}

function parseGitHubProjectPathSegments(segments: string[]): string | undefined {
  if (segments.length < 2 || !segments[0] || !segments[1]) return undefined;
  const repo = stripGitSuffix(segments[1]);
  if (!repo) return undefined;
  return `${segments[0]}/${repo}`.toLowerCase();
}

function parseGitHubActionsJobId(segments: string[]): string | undefined {
  const directJobKind = segments[5]?.toLowerCase();
  if ((directJobKind === 'job' || directJobKind === 'jobs') && isDecimal(segments[6] ?? '')) {
    return segments[6];
  }
  if (
    segments[5]?.toLowerCase() === 'attempts'
    && isDecimal(segments[6] ?? '')
    && (segments[7]?.toLowerCase() === 'job' || segments[7]?.toLowerCase() === 'jobs')
    && isDecimal(segments[8] ?? '')
  ) {
    return segments[8];
  }
  return undefined;
}

function parseGitLabProject(host: string, pathname: string): ForgeProject | undefined {
  const mergeRequest = parseGitLabSpecialPath(pathname, 'merge_requests');
  if (mergeRequest) {
    return {
      kind: 'gitlab',
      host,
      projectPath: mergeRequest.projectPath,
      reviewId: mergeRequest.id,
    };
  }

  const job = parseGitLabSpecialPath(pathname, 'jobs');
  if (job) {
    return {
      kind: 'gitlab',
      host,
      projectPath: job.projectPath,
      jobId: job.id,
    };
  }

  const pipeline = parseGitLabSpecialPath(pathname, 'pipelines');
  if (pipeline) {
    return {
      kind: 'gitlab',
      host,
      projectPath: pipeline.projectPath,
      pipelineId: pipeline.id,
    };
  }

  if (hasGitLabRoutingSegment(pathname)) return undefined;
  const projectPath = stripGitSuffix(pathname);
  if (!isGitLabProjectPath(projectPath)) return undefined;
  return {
    kind: 'gitlab',
    host,
    projectPath,
  };
}

function parseGitLabSpecialPath(
  pathname: string,
  segment: 'merge_requests' | 'jobs' | 'pipelines',
): { projectPath: string; id: string } | undefined {
  const marker = `/-/${segment}/`;
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex <= 0) return undefined;

  const idWithTail = pathname.slice(markerIndex + marker.length);
  const slashIndex = idWithTail.indexOf('/');
  const id = slashIndex === -1 ? idWithTail : idWithTail.slice(0, slashIndex);
  if (!isDecimal(id)) return undefined;

  const projectPath = stripGitSuffix(pathname.slice(0, markerIndex));
  if (!isGitLabProjectPath(projectPath)) return undefined;
  return { projectPath, id };
}

function isDecimal(value: string): boolean {
  if (!value) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function hasGitLabRoutingSegment(pathname: string): boolean {
  return pathname.split('/').some((segment) => segment === '-');
}

function isGitLabProjectPath(projectPath: string): boolean {
  return projectPath.split('/').filter(Boolean).length >= 2;
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
