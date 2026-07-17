import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../index';

/**
 * Integration tests for the OTA static mount at /api/v2/updates/static.
 *
 * Exercises the REAL app topology via createApp() from server/index.ts -- the
 * two static mounts and their cache policies, plus express.static's next()
 * fall-through for misses. Only the terminal request handler is a stand-in (a
 * distinguishable 404, so a fall-through cannot false-pass as a served file).
 * Because the app comes from the real factory, a drift in server/index.ts
 * (changed prefix, dropped cache options, reordered mounts) fails here.
 */
const HASHED_BUNDLE = '_expo/static/js/ios/entry-testhash.hbc';
const BUNDLE_CONTENT = 'console.log("ota");';

let clientDir: string;
let server: http.Server;

function rawGet(
  srv: http.Server,
  rawPath: string,
): Promise<{ status: number; body: string; cacheControl: string | undefined }> {
  const { port } = srv.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: rawPath, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            cacheControl: res.headers['cache-control'],
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  clientDir = mkdtempSync(path.join(tmpdir(), 'updates-static-'));
  mkdirSync(path.dirname(path.join(clientDir, HASHED_BUNDLE)), { recursive: true });
  writeFileSync(path.join(clientDir, HASHED_BUNDLE), BUNDLE_CONTENT);
  server = createApp({
    clientDir,
    // Stand-in for the Expo server request handler, distinguishable from a
    // statically served file so a fall-through is observable.
    requestHandler: (_req, res) => res.status(404).json({ expoRouter: true }),
  }).listen(0);
  await once(server, 'listening');
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(clientDir, { recursive: true, force: true });
});

describe('OTA static mount under /api/v2/updates/static', () => {
  it('serves a bundle through the API prefix with a long immutable cache', async () => {
    const res = await rawGet(server, `/api/v2/updates/static/${HASHED_BUNDLE}`);
    expect(res.status).toBe(200);
    expect(res.body).toBe(BUNDLE_CONTENT);
    expect(res.cacheControl).toContain('max-age=31536000');
    expect(res.cacheControl).toContain('immutable');
  });

  it('serves a bundle with the ?h= cache-buster query the manifest stamps on every URL', async () => {
    // Load-bearing for the whole cache-busting scheme: every OTA asset URL now
    // carries ?h=<content-hash> (scripts/generate-update-manifest.mjs), so the
    // static mount must resolve the file by path and ignore the query. If the
    // mount ever started matching on the full URL instead, every asset would
    // 404 and OTA would brick.
    const res = await rawGet(
      server,
      `/api/v2/updates/static/${HASHED_BUNDLE}?h=0123456789abcdef`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe(BUNDLE_CONTENT);
    expect(res.cacheControl).toContain('immutable');
  });

  it('still serves the same file at the root mount with the shorter cache', async () => {
    const res = await rawGet(server, `/${HASHED_BUNDLE}`);
    expect(res.status).toBe(200);
    expect(res.cacheControl).toContain('max-age=3600');
    // The root mount is NOT immutable -- only the OTA prefix is.
    expect(res.cacheControl).not.toContain('immutable');
  });

  it('falls through to the request handler for a missing file (not a served file)', async () => {
    const res = await rawGet(server, '/api/v2/updates/static/nonexistent.hbc');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ expoRouter: true });
  });

  it('serves /healthz', async () => {
    const res = await rawGet(server, '/healthz');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });
});
