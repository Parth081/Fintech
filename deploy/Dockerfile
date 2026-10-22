# One image for every Control Tower service. Pick the service with the command, e.g.
#   docker run --rm ct services/broker/src/index.ts
#   docker run --rm ct services/stages/src/index.ts --stage fx
# Build from the repo root:  docker build -f deploy/Dockerfile -t fintech-control-tower .
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=development \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    WEB_DIST=/app/apps/web/dist

# Whole repo (minus .dockerignore); npm ci needs every workspace's package.json to link workspaces.
COPY . .
RUN npm ci --no-audit --no-fund \
 && npm run build:web \
 && mkdir -p /data \
 && chown -R node:node /data

USER node
VOLUME ["/data"]

# Runs TypeScript directly through the tsx loader (same as the local launcher).
ENTRYPOINT ["node", "--import", "tsx"]
CMD ["services/gateway/src/index.ts"]
