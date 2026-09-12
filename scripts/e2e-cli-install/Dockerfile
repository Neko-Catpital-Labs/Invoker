FROM node:26-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates zip unzip python3 \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.31.0

RUN useradd --create-home --shell /bin/bash invoker
WORKDIR /src
COPY --chown=invoker:invoker . /src
RUN rm -rf /src/node_modules /src/release /src/packages/*/node_modules \
 && chown -R invoker:invoker /src

USER invoker
ENV CI=1
RUN pnpm install --frozen-lockfile

CMD ["bash", "scripts/e2e-cli-install/run.sh"]
