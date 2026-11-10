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

# Prepare data directory for SQLite storage and assign ownership to node user
RUN mkdir -p /app/data && chown -R node:node /app

# Run as non-root user for security
USER node

# Expose main agent port (8787) and internal seller port (8788)
EXPOSE 8787 8788

# Start both seller and agent server via the runner
CMD ["node", "tools/runner.mjs"]

