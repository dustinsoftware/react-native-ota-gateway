import { describe, expect, it } from 'vitest';

import { getOtaAppVersion } from '../ota-app-version';

describe('getOtaAppVersion', () => {
  it('returns the custom OTA app version', () => {
    expect(
      getOtaAppVersion({
        extra: { otaAppVersion: '1.1.162-ac83861' },
      }),
    ).toBe('1.1.162-ac83861');
  });

  it.each([
    undefined,
    null,
    {},
    { extra: null },
    { extra: {} },
    { extra: { otaAppVersion: '' } },
    { extra: { otaAppVersion: 123 } },
  ])('returns null for missing or malformed metadata: %j', (manifest) => {
    expect(getOtaAppVersion(manifest)).toBeNull();
  });
});
