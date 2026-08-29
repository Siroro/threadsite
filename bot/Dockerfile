FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY assets ./assets
COPY git-askpass.sh /usr/local/bin/threadsite-git-askpass
RUN chmod 0755 /usr/local/bin/threadsite-git-askpass
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
