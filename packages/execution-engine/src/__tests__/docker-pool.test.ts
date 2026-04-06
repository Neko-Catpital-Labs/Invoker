import { describe, it, expect, vi } from 'vitest';
import { DockerPool } from '../docker-pool.js';

function createMockDocker() {
  const containers: any[] = [];
  const images = new Map<string, any>();

  const docker = {
    createContainer: vi.fn().mockImplementation(async () => {
      let waitResolve: any;
      const waitPromise = new Promise((resolve) => { waitResolve = resolve; });

      const container = {
        id: `container-${containers.length}`,
        start: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockImplementation(() => {
          waitResolve({ StatusCode: 0 });
          return waitPromise;
        }),
        commit: vi.fn().mockImplementation(async (opts: any) => {
          const imageName = `${opts.repo}:${opts.tag}`;
          images.set(imageName, { name: imageName });
        }),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      containers.push(container);
      return container;
    }),
    getImage: vi.fn().mockImplementation((name: string) => {
      return {
        inspect: vi.fn().mockImplementation(async () => {
          if (images.has(name)) return { Id: name };
          throw new Error('No such image');
        }),
        remove: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };

  return { docker, containers, images };
}

describe('DockerPool', () => {
  it('ensureImage: creates cached image on first call (clone + provision)', async () => {
    const pool = new DockerPool();
    const { docker } = createMockDocker();

    const name = await pool.ensureImage(docker, 'https://github.com/test/repo.git');

    expect(name).toMatch(/^invoker-cache:/);
    expect(docker.createContainer).toHaveBeenCalledTimes(1);

    const createArgs = docker.createContainer.mock.calls[0][0];
    expect(createArgs.Entrypoint).toEqual(['/bin/sh']);
    const cmd = createArgs.Cmd[1];
    expect(cmd).toContain('git clone https://github.com/test/repo.git /app');
    expect(cmd).toContain('pnpm install --frozen-lockfile');
    expect(cmd).toContain('chmod -R a+rwX /app');
    expect(createArgs.User).toBe('0:0');
    expect(createArgs.Env).toContainEqual(expect.stringContaining('GIT_SSH_COMMAND='));
  });

  it('ensureImage: returns cached image on second call', async () => {
    const pool = new DockerPool();
    const { docker } = createMockDocker();

    const name1 = await pool.ensureImage(docker, 'https://github.com/test/repo.git');
    const name2 = await pool.ensureImage(docker, 'https://github.com/test/repo.git');

    expect(name1).toBe(name2);
    expect(docker.createContainer).toHaveBeenCalledTimes(1);
  });

  it('different repos get different cached images', async () => {
    const pool = new DockerPool();
    const { docker } = createMockDocker();

    const name1 = await pool.ensureImage(docker, 'https://github.com/test/repo1.git');
    const name2 = await pool.ensureImage(docker, 'https://github.com/test/repo2.git');

    expect(name1).not.toBe(name2);
    expect(docker.createContainer).toHaveBeenCalledTimes(2);
  });

  it('destroyAll removes all cached images', async () => {
    const pool = new DockerPool();
    const { docker } = createMockDocker();

    await pool.ensureImage(docker, 'https://github.com/test/repo.git');
    await pool.destroyAll(docker);

    expect(docker.getImage).toHaveBeenCalled();
  });

  it('imageName returns deterministic name for same URL', () => {
    const pool = new DockerPool();
    const name1 = pool.imageName('https://github.com/test/repo.git');
    const name2 = pool.imageName('https://github.com/test/repo.git');
    expect(name1).toBe(name2);
    expect(name1).toMatch(/^invoker-cache:[a-f0-9]{12}$/);
  });

  it('respects custom config', () => {
    const pool = new DockerPool({ baseImage: 'my-base:v1', imagePrefix: 'my-prefix' });
    const name = pool.imageName('https://github.com/test/repo.git');
    expect(name).toMatch(/^my-prefix:[a-f0-9]{12}$/);
  });

  it('ensureImage: throws on clone failure', async () => {
    const pool = new DockerPool();
    const { docker } = createMockDocker();

    docker.createContainer.mockImplementationOnce(async () => {
      let waitResolve: any;
      const waitPromise = new Promise((resolve) => { waitResolve = resolve; });
      const container = {
        id: 'fail-container',
        start: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockImplementation(() => {
          waitResolve({ StatusCode: 128 });
          return waitPromise;
        }),
        commit: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      return container;
    });

    await expect(
      pool.ensureImage(docker, 'https://github.com/test/bad-repo.git'),
    ).rejects.toThrow('Failed to clone');
  });

  it('ensureImage: reuses Docker image if already built', async () => {
    const pool = new DockerPool();
    const { docker, images } = createMockDocker();

    const repoUrl = 'https://github.com/test/existing.git';
    const expectedName = pool.imageName(repoUrl);
    images.set(expectedName, { name: expectedName });

    const name = await pool.ensureImage(docker, repoUrl);

    expect(name).toBe(expectedName);
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('ensureImage: mounts SSH dir when configured', async () => {
    const pool = new DockerPool({ sshDir: '/home/user/.ssh' });
    const { docker } = createMockDocker();

    await pool.ensureImage(docker, 'git@github.com:test/private-repo.git');

    const createArgs = docker.createContainer.mock.calls[0][0];
    expect(createArgs.HostConfig.Binds).toContainEqual('/home/user/.ssh:/root/.ssh:ro');
  });

  it('ensureImage: no SSH binds when sshDir is not configured', async () => {
    const pool = new DockerPool();
    const { docker } = createMockDocker();

    await pool.ensureImage(docker, 'https://github.com/test/repo.git');

    const createArgs = docker.createContainer.mock.calls[0][0];
    expect(createArgs.HostConfig.Binds).toBeUndefined();
  });
});
