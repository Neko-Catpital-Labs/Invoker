# Hello-world fixture image consumed by scripts/e2e-docker-hello-world.sh.
#
# Demonstrates the static-image pattern: a downstream project image that
# layers on top of invoker/agent-base:latest. The image owns the user, the
# repo at /app, and the git config; DockerFamiliar only ever creates and
# destroys containers from this image.

FROM invoker/agent-base:latest

USER root
RUN git init /app \
    && cd /app \
    && git config user.email "test@invoker.local" \
    && git config user.name "Invoker E2E" \
    && printf '# hello\n' > README.md \
    && git add . \
    && git commit -m "seed" \
    && chown -R invoker:invoker /app

USER invoker
WORKDIR /app
