FROM node:24-bookworm-slim

ARG OPENCODE_VERSION=2.1.3
RUN npm install -g "@opencode/cli@${OPENCODE_VERSION}" \
    && mkdir -p /opencode-data /workspace /opt/threadsite

# LSP servers and formatter used by the opencode.json lsp/formatter sections.
# Installed globally with the TypeScript compiler used by the validation gate.
RUN npm install -g typescript-language-server "typescript@5.9.3" \
    vscode-langservers-extracted prettier

# unzip for extracting downloaded asset archives (tar/gzip ship with the base image).
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip ripgrep \
    && rm -rf /var/lib/apt/lists/*

COPY opencode.json /opt/threadsite/opencode.base.json
COPY start.mjs /opt/threadsite/start.mjs
COPY runtime-config.mjs /opt/threadsite/runtime-config.mjs
COPY healthcheck.mjs /opt/threadsite/healthcheck.mjs
COPY provider-config.mjs /opt/threadsite/provider-config.mjs
COPY providers.json /opt/threadsite/providers.json
COPY package.json package-lock.json /opt/threadsite/
COPY v2/ /opt/threadsite/v2/
COPY tools/ /opt/threadsite/tools/
COPY lib/ /opt/threadsite/lib/
RUN cd /opt/threadsite && npm ci && npm run build

WORKDIR /workspace
EXPOSE 4096
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 CMD ["node", "/opt/threadsite/healthcheck.mjs"]
CMD ["node", "/opt/threadsite/start.mjs"]
