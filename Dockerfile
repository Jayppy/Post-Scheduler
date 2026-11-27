# Multi-stage production build for 74 STUDIO SOCIAL HUB on Google Cloud Run
FROM node:20-bullseye-slim AS builder

WORKDIR /app

# Install build essentials if required
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production runtime stage
FROM node:20-bullseye-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Install FFmpeg with H.264 (libx264) and AAC support
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && ffmpeg -version | head -n 1

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built frontend assets and server codebase
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/server ./server
COPY --from=builder /app/public ./public
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Ensure data directory exists with restricted permissions
RUN mkdir -p /app/.data && chmod 700 /app/.data

EXPOSE 8080

USER node

CMD ["npm", "start"]
