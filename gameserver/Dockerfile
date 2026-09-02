FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production
# ARENA (single-mode) worlds persist here; mount a volume at /data to keep
# them across container recreation.
ENV GAMESERVER_STATE_DIR=/data/threadsite-relay
EXPOSE 8090
CMD ["node", "dist/server.js"]
