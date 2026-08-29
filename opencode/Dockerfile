FROM node:24-bookworm-slim

ARG OPENCODE_VERSION=1.18.25
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" \
    && mkdir -p /root/.config/opencode/tools /opencode-data /workspace /opt/threadsite

# LSP servers and formatter used by the opencode.json lsp/formatter sections.
# Installed globally so they resolve in every workspace regardless of whether
# the generated site has its own package.json.
RUN npm install -g typescript-language-server typescript \
    vscode-langservers-extracted prettier

# unzip for extracting downloaded asset archives (tar/gzip ship with the base image).
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/*

COPY opencode.json /opt/threadsite/opencode.base.json
COPY start.mjs /opt/threadsite/start.mjs
COPY surplus-adapter.mjs /opt/threadsite/surplus-adapter.mjs
COPY tools/asset_download.ts /root/.config/opencode/tools/asset_download.ts
COPY tools/js_syntax_check.ts /root/.config/opencode/tools/js_syntax_check.ts
COPY tools/project_notes.ts /root/.config/opencode/tools/project_notes.ts

WORKDIR /workspace
EXPOSE 4096
CMD ["node", "/opt/threadsite/start.mjs"]
