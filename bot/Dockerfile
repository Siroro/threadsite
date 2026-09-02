FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
# three/phaser/@types/three are the seed sources for workspace engine
# packages (see src/engines.ts) — pruned here to just the files the seeder
# reads, so the image carries the engines without their full trees.
RUN npm ci --omit=dev --no-audit --no-fund \
    && rm -rf node_modules/three/examples node_modules/three/src \
    && find node_modules/three/build -type f ! -name 'three.module.min.js' ! -name 'three.core.min.js' -delete \
    && find node_modules/@types/three -mindepth 1 -maxdepth 1 ! -name 'index.d.ts' ! -name 'src' ! -name 'package.json' -exec rm -rf {} + \
    && find node_modules/phaser -mindepth 1 -maxdepth 1 ! -name 'dist' ! -name 'types' ! -name 'package.json' ! -name 'LICENSE.md' -exec rm -rf {} + \
    && find node_modules/phaser/dist -type f ! -name 'phaser.esm.min.js' -delete \
    && find node_modules/phaser/types -type f ! -name 'phaser.d.ts' ! -name 'matter.d.ts' -delete
COPY --from=build /app/dist ./dist
COPY assets ./assets
COPY git-askpass.sh /usr/local/bin/threadsite-git-askpass
RUN chmod 0755 /usr/local/bin/threadsite-git-askpass
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
