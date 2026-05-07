# ---- build stage ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-bookworm-slim
# ffmpeg + ffprobe + CA certs (for HTTPS to S3 / RDS)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

ENV NODE_ENV=production
# Default entrypoint runs the SQS/Batch worker. Override with
#   docker run ... node dist/cli.js -i ... -o ...
# to use the same image as a one-shot CLI tool.
ENTRYPOINT ["node", "dist/worker.js"]
