# Standalone OTA gateway server image (Mode B serving).
#
# Serves a baked `dist/` export (client assets + expo-server API routes,
# including the OTA manifest) through server/index.ts. The image contains ONLY
# the server runtime -- express, expo-server, tsx -- not the React Native /
# Expo dependency tree; the JS bundles it serves are produced on the host by
# `pnpm --filter @ota-gateway/mobile export` BEFORE building the image.
#
# Because dist/ is baked in, every re-export requires an image rebuild
# (`docker compose up --build`); that is deliberate -- the container is a
# release artifact, matching what production serving looks like, so Mode B
# testing never picks up dev-server behavior from the host checkout.
#
# Build from the apps/mobile directory:
#   docker build -t ota-gateway .
# or use the repo-root docker-compose.yml (services: gateway-dev / gateway-prod).
FROM node:24-alpine

WORKDIR /app

# Server runtime deps only. Versions track apps/mobile/package.json -- keep in
# sync when bumping express / expo-server / tsx there.
RUN npm install --no-package-lock --omit=dev \
    express@^5.2.1 \
    expo-server@55.0.6 \
    tsx@^4.21.0

COPY server ./server
COPY dist ./dist

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
    CMD wget -qO- "http://localhost:${PORT}/healthz" || exit 1

CMD ["npx", "tsx", "server/index.ts"]
