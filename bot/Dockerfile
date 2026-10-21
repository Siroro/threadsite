FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig*.json ./
COPY src ./src
COPY networking ./networking
COPY assets ./assets
RUN npm run build && npm run stage:engines

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
# The engine packages (three, phaser, @dimforge/rapier3d-compat,
# three-mesh-bvh, @types/three) are devDependencies — build-time seed
# sources only, never imported by the running bot. dist/stage-engines.js
# staged the exact payload the seeder reads (per the spec in src/engines.ts)
# into engine-seed/ during the build stage; the runtime installs production
# dependencies only and reads engines from the staged tree.
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets
COPY --from=build /app/engine-seed ./engine-seed
COPY git-askpass.sh /usr/local/bin/threadsite-git-askpass
RUN chmod 0755 /usr/local/bin/threadsite-git-askpass
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
