FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=1.18.25
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" \
    && mkdir -p /root/.config/opencode/tools /opencode-data /workspace /opt/threadsite

COPY opencode.json /opt/threadsite/opencode.base.json
COPY start.mjs /opt/threadsite/start.mjs
COPY tools/asset_download.ts /root/.config/opencode/tools/asset_download.ts
COPY tools/js_syntax_check.ts /root/.config/opencode/tools/js_syntax_check.ts
COPY tools/project_notes.ts /root/.config/opencode/tools/project_notes.ts

WORKDIR /workspace
EXPOSE 4096
CMD ["node", "/opt/threadsite/start.mjs"]
