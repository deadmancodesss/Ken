# The binary is copied out of its own image rather than installed with a script, and it
# is pinned to the version whose restore and replication behavior was tested locally.
FROM litestream/litestream:0.5.18 AS litestream

FROM node:22-bookworm-slim

# Set working directory
WORKDIR /app

# Install dependencies (cached layer)
COPY package.json package-lock.json ./
RUN npm ci

# Set default production environment variables
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV SELLER_HOST=127.0.0.1
ENV SELLER_PORT=8788

# Copy application source and assets
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY tools/ ./tools/

# Litestream runs as the same non-root user as the app and reads every store in
# tools/litestream.yml, so it needs to be executable inside the image.
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream

# Prepare data directory for SQLite storage and assign ownership to node user
RUN mkdir -p /app/data && chmod +x /app/tools/docker-entrypoint.sh && chown -R node:node /app

# Run as non-root user for security
USER node

# Expose main agent port (8787) and internal seller port (8788)
EXPOSE 8787 8788

# Restore each SQLite store from R2, then supervise the app as a child so Render's
# SIGTERM reaches the runner and the last writes are flushed before the container stops.
ENTRYPOINT ["/app/tools/docker-entrypoint.sh"]
CMD ["node", "tools/runner.mjs"]

