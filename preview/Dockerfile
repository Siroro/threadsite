FROM node:24-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npx playwright install --with-deps --no-shell chromium \
    && rm -rf /var/lib/apt/lists/*
COPY *.mjs ./
COPY browser-config.json ./
USER node
EXPOSE 8931
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 CMD ["node", "/app/healthcheck.mjs"]
CMD ["node", "/app/start.mjs"]
