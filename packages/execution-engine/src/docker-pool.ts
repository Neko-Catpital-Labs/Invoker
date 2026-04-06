import { createHash } from 'node:crypto';

export interface DockerPoolConfig {
  /** Base image to start from when building cached images. Default: 'invoker-agent:latest'. */
  baseImage?: string;
  /** Prefix for cached image names. Default: 'invoker-cache'. */
  imagePrefix?: string;
  /** Host SSH directory to mount into clone containers for private repo access. */
  sshDir?: string;
}

export class DockerPool {
  private readonly baseImage: string;
  private readonly imagePrefix: string;
  private readonly sshDir: string | undefined;
  /** Track cached image names per repo URL. */
  private cachedImages = new Map<string, string>();

  constructor(config: DockerPoolConfig = {}) {
    this.baseImage = config.baseImage ?? 'invoker-agent:latest';
    this.imagePrefix = config.imagePrefix ?? 'invoker-cache';
    this.sshDir = config.sshDir;
  }

  /**
   * Deterministic hash of a repo URL for image tagging.
   */
  private urlHash(repoUrl: string): string {
    return createHash('sha256').update(repoUrl).digest('hex').slice(0, 12);
  }

  /**
   * Get the cached image name for a repo URL.
   */
  imageName(repoUrl: string): string {
    return `${this.imagePrefix}:${this.urlHash(repoUrl)}`;
  }

  /**
   * Ensure a cached image exists for the given repo URL.
   * Clones the repo into the base image, runs dependency provisioning
   * (`pnpm install` if a lockfile exists), and commits the result.
   */
  async ensureImage(docker: any, repoUrl: string): Promise<string> {
    const name = this.imageName(repoUrl);

    if (this.cachedImages.has(repoUrl)) {
      return this.cachedImages.get(repoUrl)!;
    }

    try {
      const image = docker.getImage(name);
      await image.inspect();
      this.cachedImages.set(repoUrl, name);
      return name;
    } catch {
      // Image doesn't exist — build it
    }

    const binds: string[] = [];
    if (this.sshDir) {
      binds.push(`${this.sshDir}:/root/.ssh:ro`);
    }

    const cloneAndProvision = [
      `git clone ${repoUrl} /app`,
      'cd /app',
      '[ -f pnpm-lock.yaml ] && (NODE_ENV=development pnpm install --frozen-lockfile || (NODE_ENV=development pnpm install --lockfile-only && NODE_ENV=development pnpm install --frozen-lockfile)) || true',
      'chmod -R a+rwX /app /opt/corepack 2>/dev/null || true',
    ].join(' && ');

    const container = await docker.createContainer({
      Image: this.baseImage,
      Entrypoint: ['/bin/sh'],
      Cmd: ['-c', cloneAndProvision],
      WorkingDir: '/',
      User: '0:0',
      Env: [
        'GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new -F /dev/null',
        'COREPACK_HOME=/opt/corepack',
      ],
      HostConfig: {
        NetworkMode: 'host',
        ...(binds.length > 0 ? { Binds: binds } : {}),
      },
    });

    await container.start();
    const result = await container.wait();

    if (result.StatusCode !== 0) {
      try { await container.remove(); } catch { /* */ }
      throw new Error(`Failed to clone ${repoUrl} into cached image (exit code ${result.StatusCode})`);
    }

    await container.commit({
      repo: this.imagePrefix,
      tag: this.urlHash(repoUrl),
      changes: ['WORKDIR /app'],
    });

    try { await container.remove(); } catch { /* */ }

    this.cachedImages.set(repoUrl, name);
    return name;
  }

  /**
   * Remove all cached images from Docker.
   */
  async destroyAll(docker: any): Promise<void> {
    for (const [, imageName] of this.cachedImages) {
      try {
        const image = docker.getImage(imageName);
        await image.remove({ force: true });
      } catch {
        // Image may already be removed
      }
    }
    this.cachedImages.clear();
  }
}
