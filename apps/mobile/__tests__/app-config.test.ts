import { afterEach, describe, expect, it } from 'vitest';

import { resolveGateway } from '../app.config';

const URLS = {
  development: 'https://dev.test.example',
  production: 'https://www.test.example',
};

const savedEnvironment = process.env.OTA_ENVIRONMENT;
const savedOverride = process.env.OTA_GATEWAY_URL;

afterEach(() => {
  if (savedEnvironment === undefined) delete process.env.OTA_ENVIRONMENT;
  else process.env.OTA_ENVIRONMENT = savedEnvironment;
  if (savedOverride === undefined) delete process.env.OTA_GATEWAY_URL;
  else process.env.OTA_GATEWAY_URL = savedOverride;
});

/**
 * Pins the bake-side fail-toward-production polarity: only an explicit
 * OTA_ENVIRONMENT=development may select the dev gateway. A future
 * "consistency cleanup" aligning this with the server's strict
 * === 'production' checks would bake dev into shipped frameworks -- this
 * suite makes that regression unmergeable.
 */
describe('app.config resolveGateway', () => {
  it('defaults to the production gateway when OTA_ENVIRONMENT is unset', () => {
    delete process.env.OTA_ENVIRONMENT;
    delete process.env.OTA_GATEWAY_URL;
    expect(resolveGateway(URLS)).toBe(URLS.production);
  });

  it('treats anything other than exactly "development" as production', () => {
    delete process.env.OTA_GATEWAY_URL;
    for (const value of ['production', 'Development', 'dev', 'staging', '']) {
      process.env.OTA_ENVIRONMENT = value;
      expect(resolveGateway(URLS)).toBe(URLS.production);
    }
  });

  it('selects the dev gateway only on an explicit development opt-in', () => {
    delete process.env.OTA_GATEWAY_URL;
    process.env.OTA_ENVIRONMENT = 'development';
    expect(resolveGateway(URLS)).toBe(URLS.development);
  });

  it('lets OTA_GATEWAY_URL override the selection, trimming trailing slashes', () => {
    process.env.OTA_ENVIRONMENT = 'development';
    process.env.OTA_GATEWAY_URL = 'https://pinned.test.example///';
    expect(resolveGateway(URLS)).toBe('https://pinned.test.example');
  });
});
