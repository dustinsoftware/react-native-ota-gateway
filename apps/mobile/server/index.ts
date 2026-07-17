import path from 'node:path';
import express from 'express';
import { createRequestHandler } from 'expo-server/adapter/express';

const PORT = Number(process.env.PORT) || 3000;

// OTA_ENVIRONMENT selects which gateway host the manifest route advertises and
// which per-environment update id it derives. It is read per request inside
// src/app/api/v2/updates/manifest+api.ts (strict === 'production'); the server
// only needs it present in process.env, which tsx/node already provide. Logged
// here so a running instance's environment is visible.
const OTA_ENVIRONMENT = process.env.OTA_ENVIRONMENT ?? 'development';

const CLIENT_DIR = path.join(__dirname, '..', 'dist', 'client');
const SERVER_BUILD = path.join(__dirname, '..', 'dist', 'server');

export interface CreateAppOptions {
  /** Static assets dir (dist/client). Overridable for tests. */
  clientDir?: string;
  /**
   * Terminal request handler. Defaults to the Expo server request handler over
   * dist/server; callers may pass a stand-in so no export build is required.
   */
  requestHandler?: express.RequestHandler;
}

/**
 * Build the demo backend Express app. Exported (rather than inlined into the
 * listen call) so the real middleware topology -- both static mounts and the OTA
 * static prefix -- can be exercised without a hand-copied mirror that could
 * drift.
 */
export function createApp(options: CreateAppOptions = {}): express.Express {
  const clientDir = options.clientDir ?? CLIENT_DIR;

  const app = express();

  // Health check for container orchestrators.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Static assets (JS bundles, images, fonts) for the standalone web app. The
  // same dir is re-served below under /api/v2/updates/static with a long
  // immutable cache for OTA.
  app.use(express.static(clientDir, { maxAge: '1h', index: false }));

  // OTA bundles/assets, mirrored under the API prefix: the OTA manifest
  // (scripts/generate-update-manifest.mjs) emits its asset URLs here. The long
  // immutable maxAge is safe ONLY because the manifest stamps a
  // ?h=<content-hash> cache-buster on every asset URL -- Metro's entry-<hash>
  // FILENAME is not reliably content-addressed (two deploys have shipped the
  // same filename with different bytes, and the stale edge-cached copy failed
  // every client's expo-updates hash check). See docs/ota-updates.md.
  app.use(
    '/api/v2/updates/static',
    express.static(clientDir, { maxAge: '365d', immutable: true, index: false }),
  );

  // Expo handles all routing: API routes (incl. the OTA manifest), the
  // standalone web HTML pages, and 404s.
  app.use(options.requestHandler ?? createRequestHandler({ build: SERVER_BUILD }));

  return app;
}

// Only listen when run directly (tsx / node); importers get createApp() without
// opening a socket.
if (require.main === module) {
  createApp().listen(PORT, '0.0.0.0', () => {
    console.log(`[ota-gateway] Server listening on port ${PORT}`);
    console.log(`[ota-gateway] OTA_ENVIRONMENT=${OTA_ENVIRONMENT}`);
  });
}
