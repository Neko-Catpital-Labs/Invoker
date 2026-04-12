# Docker executor — static image architecture

## TL;DR

- **Layer ownership.** The image declares the user, HOME, paths, installed
  tools, and repo contents. Invoker owns container lifecycle only.
- **Secrets.** Credentials live in a host file (`~/.config/invoker/secrets.env`,
  chmod 600) and are loaded into the container's `Env` array at start time.
- **No bind mounts.** `DockerExecutor` does not mount host paths into the
  container. Anything the task needs must be in the image.
- **No User override.** Containers run as the user declared by the image.

## Build the base image

The base image (`invoker/agent-base:latest`) is generated on demand by
`scripts/build-agent-base-image.sh`. The Dockerfile is **not committed**;
it lives inline in the script as a heredoc:

```bash
bash scripts/build-agent-base-image.sh
```

To build with a custom tag:

```bash
TAG=my/agent-base:dev bash scripts/build-agent-base-image.sh
```

The base image contains:

- `node:22-slim` + `pnpm` (via corepack)
- `@anthropic-ai/claude-code` (Claude CLI)
- `git`, `curl`, `jq`, `python3`, `make`, `g++`, `openssh-client`
- Non-root `invoker` user with `HOME=/home/invoker` (so `~/.cache` writes
  do not need UID compensators)
- Default `CMD ["tail", "-f", "/dev/null"]` so DockerExecutor's idle override
  is a no-op for standalone runs

## Build a project image

Downstream projects layer their own image on top of the base:

```dockerfile
# my-project/Dockerfile
FROM invoker/agent-base:latest
USER root
COPY . /app
RUN chown -R invoker:invoker /app
USER invoker
WORKDIR /app
RUN pnpm install --frozen-lockfile
```

```bash
docker build -t my-project:latest .
```

Then point Invoker at it via `~/.invoker/config.json`:

```json
{
  "docker": {
    "imageName": "my-project:latest",
    "secretsFile": "~/.config/invoker/secrets.env"
  }
}
```

## Secrets file format

`secrets.env` is a minimal `KEY=value` file. Permissions must be chmod 600
or 400 (no group/other bits set) — the loader refuses to read looser files.

```env
ANTHROPIC_API_KEY=sk-ant-...
GIT_HTTPS_TOKEN=ghp-...
OPENAI_API_KEY=sk-...
```

Rules:

- One `KEY=value` per line
- `#` starts a comment
- Blank lines are ignored
- Optional surrounding single or double quotes are stripped
- No multiline values, no variable interpolation
- Keys must match `^[A-Za-z_][A-Za-z0-9_]*$`

To set up:

```bash
mkdir -p ~/.config/invoker
touch ~/.config/invoker/secrets.env
chmod 600 ~/.config/invoker/secrets.env
$EDITOR ~/.config/invoker/secrets.env
```

If `docker.secretsFile` is not set in `.invoker/config.json`, Invoker
falls back to `~/.config/invoker/secrets.env` when that file exists. If
the file is missing entirely, no extra env is forwarded.

## Git over HTTPS

Because there are no bind mounts, the container cannot use the host
`~/.ssh` directory for git authentication. Use an HTTPS token instead:

```env
GIT_HTTPS_TOKEN=ghp-xxxxxxxxxxxxxxxxxxxx
```

Then configure git inside the project image to use it (typically via the
project's own Dockerfile or runtime setup).

## End-to-end smoke test

`scripts/e2e-docker-hello-world.sh` runs the full pipeline against a
fixture image. It builds both `invoker/agent-base:latest` and the
fixture image on first run, then submits a single ai_task plan and
asserts task completion.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
bash scripts/e2e-docker-hello-world.sh
```

Source files:

- `scripts/build-agent-base-image.sh`
- `scripts/e2e-docker-hello-world.sh`
- `scripts/fixtures/hello-world-agent/Dockerfile`
- `scripts/fixtures/hello-world-agent/plan.yaml`

## Migration from the old (compensator) model

Pre-refactor, `DockerExecutor` injected `HOME=/home/invoker`,
`COREPACK_HOME=/opt/corepack`, ran the container as the host UID via
`User: ${uid}:${gid}`, bind-mounted `~/.claude` and `~/.ssh`, and
forwarded `ANTHROPIC_API_KEY` from `process.env`. All of these are
removed.

If you previously relied on:

- **Host `~/.claude` login** → put `ANTHROPIC_API_KEY` in `secrets.env`
- **Host `~/.ssh` keys for git** → use `GIT_HTTPS_TOKEN` in `secrets.env`
- **The image running as host UID** → declare a user in your project
  image; the base image already provides `invoker` (UID 1000)
- **`docker.repoInImage` config field** → removed; the project image
  always owns `/app`. There is no longer an automatic clone-and-commit
  pool.
