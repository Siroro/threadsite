FROM node:24-bookworm-slim

ARG OPENCODE_VERSION=2.1.4
RUN npm install -g "@opencode/cli@${OPENCODE_VERSION}" \
    && mkdir -p /opencode-data /workspace /opt/threadsite

# LSP servers and formatter used by the opencode.json lsp/formatter sections.
# Installed globally with the TypeScript compiler used by the validation gate.
RUN npm install -g typescript-language-server "typescript@5.9.3" \
    vscode-langservers-extracted prettier

# unzip for extracting downloaded asset archives (tar/gzip ship with the base image).
# Media toolchain for asset-forge: ffmpeg/ffprobe transcode audio and convert
# images, gltfpack compresses glTF models, and fonts-dejavu-core backs svg2png
# text rendering (installed with the service files below).
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip ripgrep ffmpeg fonts-dejavu-core \
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
COPY svg2png/ /opt/threadsite/svg2png/
COPY lib/ /opt/threadsite/lib/
RUN cd /opt/threadsite && npm ci && npm run build

# Media CLIs for asset-forge: model compression and the svg2png rasterizer
# wrapper. npm -g on a folder symlinks instead of installing dependencies, so
# the wrapper installs in place and links onto PATH itself.
RUN npm install -g gltfpack@1.3.0 \
    && cd /opt/threadsite/svg2png && npm install --omit=dev \
    && chmod +x bin/svg2png.mjs \
    && ln -s /opt/threadsite/svg2png/bin/svg2png.mjs /usr/local/bin/svg2png

WORKDIR /workspace
EXPOSE 4096
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 CMD ["node", "/opt/threadsite/healthcheck.mjs"]
CMD ["node", "/opt/threadsite/start.mjs"]
