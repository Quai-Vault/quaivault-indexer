# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for TypeScript)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S indexer -u 1001 -G nodejs

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy built output from builder stage
COPY --from=builder /app/dist ./dist

# Set ownership
RUN chown -R indexer:nodejs /app

# Switch to non-root user
USER indexer

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${HEALTH_CHECK_PORT:-3000}/live || exit 1

# Expose health check port
EXPOSE ${HEALTH_CHECK_PORT:-3000}

# Run the indexer
CMD ["node", "dist/index.js"]
