import { createHash } from 'node:crypto';

export interface DockerPoolConfig {
  /** Base image to start from when building cached images. Default: 'invoker-agent:latest'. */
  baseImage?: string;
  /** Prefix for cached image names. Default: 'invoker-cache'. */
  imagePrefix?: string;
}

export class DockerPool {
  private readonly baseImage: string;
  private readonly imagePrefix: string;
  /** Track cached image names per repo URL. */
  private cachedImages = new Map<string, string>();

  constructor(config: DockerPoolConfig = {}) {
    this.baseImage = config.baseImage ?? 'invoker-agent:latest';
    this.imagePrefix = config.imagePrefix ?? 'invoker-cache';
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
   * If not cached:
   *   1. Start a temp container from baseImage
   *   2. Run `git clone <repoUrl> /app` inside it
   *   3. `docker commit` the container as a cached image
   *   4. Remove the temp container
   * Returns the cached image name.
   */
  async ensureImage(docker: any, repoUrl: string): Promise<string> {
    const name = this.imageName(repoUrl);

    // Already cached in memory
    if (this.cachedImages.has(repoUrl)) {
      return this.cachedImages.get(repoUrl)!;
    }

    // Check if image exists in Docker
    try {
      const image = docker.getImage(name);
      await image.inspect();
      this.cachedImages.set(repoUrl, name);
      return name;
    } catch {
      // Image doesn't exist — build it
    }

    // Create temp container from base image, clone repo, commit
    const container = await docker.createContainer({
      Image: this.baseImage,
      Entrypoint: ['git'],
      Cmd: ['clone', repoUrl, '/app'],
      WorkingDir: '/',
      HostConfig: { NetworkMode: 'host' },
    });

    await container.start();
    const result = await container.wait();

    if (result.StatusCode !== 0) {
      try { await container.remove(); } catch { /* */ }
      throw new Error(`Failed to clone ${repoUrl} into cached image (exit code ${result.StatusCode})`);
    }

    // Commit the container as a new image, restoring the original entrypoint
    // (overridden during clone step)
    await container.commit({
      repo: this.imagePrefix,
      tag: this.urlHash(repoUrl),
      changes: ['ENTRYPOINT ["/usr/local/bin/invoker-agent.sh"]', 'WORKDIR /app'],
    });

    // Remove temp container
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
