FROM node:24-bookworm-slim

ARG OPENCODE_VERSION=1.18.27
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" \
    && mkdir -p /root/.config/opencode/tools /opencode-data /workspace /opt/threadsite

# LSP servers and formatter used by the opencode.json lsp/formatter sections.
# Installed globally with the TypeScript compiler used by the validation gate.
RUN npm install -g typescript-language-server "typescript@5.9.3" \
    vscode-langservers-extracted prettier

# unzip for extracting downloaded asset archives (tar/gzip ship with the base image).
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/*

COPY opencode.json /opt/threadsite/opencode.base.json
COPY start.mjs /opt/threadsite/start.mjs
COPY runtime-config.mjs /opt/threadsite/runtime-config.mjs
COPY healthcheck.mjs /opt/threadsite/healthcheck.mjs
COPY surplus-adapter.mjs /opt/threadsite/surplus-adapter.mjs
COPY tools/asset_download.ts /root/.config/opencode/tools/asset_download.ts
COPY tools/js_syntax_check.ts /root/.config/opencode/tools/js_syntax_check.ts
COPY tools/project_notes.ts /root/.config/opencode/tools/project_notes.ts

WORKDIR /workspace
EXPOSE 4096
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 CMD ["node", "/opt/threadsite/healthcheck.mjs"]
CMD ["node", "/opt/threadsite/start.mjs"]
