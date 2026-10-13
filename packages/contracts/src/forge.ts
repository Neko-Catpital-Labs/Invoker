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
  const trimmed = path.slice(0, end);
  return trimmed.slice(-4).toLowerCase() === '.git' ? trimmed.slice(0, -4) : trimmed;
}

function gitlabHostsFromEnv(): Set<string> {
  const hosts = new Set<string>([DEFAULT_GITLAB_HOST]);
  const raw = process.env.INVOKER_GITLAB_HOST?.trim();
  if (!raw) return hosts;
  for (const part of raw.split(',')) {
    const host = part.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (host) hosts.add(host);
  }
  return hosts;
}

function hostWithoutPort(host: string): string {
  return host.replace(/:\d+$/, '');
}

function parseScpOrUrl(raw: string): { host: string; pathname: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const scpLike = /^git@([^:]+):(.+)$/i.exec(trimmed);
  if (scpLike) {
    return { host: scpLike[1].toLowerCase(), pathname: scpLike[2] };
  }

  const sshUrl = /^ssh:\/\/(?:git@)?([^/]+)\/(.+)$/i.exec(trimmed);
  if (sshUrl) {
    return { host: sshUrl[1].toLowerCase(), pathname: sshUrl[2] };
  }

  try {
    const parsed = new URL(trimmed);
    if (!parsed.host || !['http:', 'https:', 'ssh:'].includes(parsed.protocol)) return undefined;
    if (parsed.search || parsed.hash) return undefined;
    const pathname = parsed.pathname.replace(/^\/+/, '');
    if (!pathname) return undefined;
    return { host: parsed.host.toLowerCase(), pathname };
  } catch {
    return undefined;
  }
}

function parseGitHubProject(host: string, pathname: string): ForgeProject | undefined {
  const pullMatch = /^([^/]+)\/([^/]+?)(?:\.git)?\/pull\/(\d+)(?:\/.*)?$/i.exec(pathname);
  if (pullMatch) {
    return {
      kind: 'github',
      host,
      projectPath: `${pullMatch[1]}/${pullMatch[2]}`.toLowerCase(),
      reviewId: pullMatch[3],
    };
  }

  const actionsMatch =
    /^([^/]+)\/([^/]+?)(?:\.git)?\/actions\/runs\/(\d+)(?:\/(?:attempts\/\d+\/)?jobs?\/(\d+))?/i.exec(
      pathname,
    );
  if (actionsMatch) {
    return {
      kind: 'github',
      host,
      projectPath: `${actionsMatch[1]}/${actionsMatch[2]}`.toLowerCase(),
      runId: actionsMatch[3],
      ...(actionsMatch[4] ? { jobId: actionsMatch[4] } : {}),
    };
  }

  const repoMatch = /^([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(pathname);
  if (repoMatch) {
    return {
      kind: 'github',
      host,
      projectPath: `${repoMatch[1]}/${repoMatch[2]}`.toLowerCase(),
    };
  }

  return undefined;
}

function isDecimalSegment(segment: string | undefined): segment is string {
  if (!segment) return false;
  for (let i = 0; i < segment.length; i += 1) {
    const code = segment.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function validGitLabProjectPath(projectPath: string): boolean {
  return projectPath.split('/').filter(Boolean).length >= 2;
}

function parseGitLabRoute(
  pathname: string,
  route: string,
): { projectPath: string; id: string } | undefined {
  const segments = pathname.split('/');
  const separatorIndex = segments.indexOf('-');
  if (separatorIndex === -1) return undefined;
  if (segments[separatorIndex + 1] !== route) return undefined;

  const id = segments[separatorIndex + 2];
  if (!isDecimalSegment(id)) return undefined;

  const projectPath = stripGitSuffix(segments.slice(0, separatorIndex).join('/'));
  if (!validGitLabProjectPath(projectPath)) return undefined;
  return { projectPath, id };
}

function parseGitLabProject(host: string, pathname: string): ForgeProject | undefined {
  const mrMatch = parseGitLabRoute(pathname, 'merge_requests');
  if (mrMatch) {
    return {
      kind: 'gitlab',
      host,
      projectPath: mrMatch.projectPath,
      reviewId: mrMatch.id,
    };
  }

  const jobMatch = parseGitLabRoute(pathname, 'jobs');
  if (jobMatch) {
    return {
      kind: 'gitlab',
      host,
      projectPath: jobMatch.projectPath,
      jobId: jobMatch.id,
    };
  }

  const pipelineMatch = parseGitLabRoute(pathname, 'pipelines');
  if (pipelineMatch) {
    return {
      kind: 'gitlab',
      host,
      projectPath: pipelineMatch.projectPath,
      pipelineId: pipelineMatch.id,
    };
  }

  if (pathname.split('/').includes('-')) return undefined;
  const projectPath = stripGitSuffix(pathname);
  if (!validGitLabProjectPath(projectPath)) return undefined;
  return {
    kind: 'gitlab',
    host,
    projectPath,
  };
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
