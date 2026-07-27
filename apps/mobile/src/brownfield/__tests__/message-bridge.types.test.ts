import { describe, expect, it } from 'vitest';

import { nativeToRNSchema } from '../message-bridge.types';

// The native host is in-process but untyped: every inbound message crosses this
// Zod boundary before app code touches it. Pin that valid messages parse and
// that anything malformed/unknown is rejected (so the bridge drops it rather
// than dispatching garbage).

describe('nativeToRNSchema', () => {
  it('accepts a valid featureFlag message', () => {
    const r = nativeToRNSchema.safeParse({ type: 'featureFlag', key: 'newCheckout', enabled: true });
    expect(r.success).toBe(true);
  });

  it('accepts a valid config message (including an empty payload)', () => {
    expect(nativeToRNSchema.safeParse({ type: 'config', payload: { a: 1, b: 'x' } }).success).toBe(true);
    expect(nativeToRNSchema.safeParse({ type: 'config', payload: {} }).success).toBe(true);
  });

  it('accepts a selectTab message with any string route (routes are validated in the handler)', () => {
    expect(nativeToRNSchema.safeParse({ type: 'selectTab', route: '/sky' }).success).toBe(true);
    // The schema keeps route a bare string on purpose -- an unknown route still
    // parses here and is ignored downstream (the documented skew guarantee).
    expect(nativeToRNSchema.safeParse({ type: 'selectTab', route: '/nope' }).success).toBe(true);
  });

  it('rejects a selectTab missing or mistyping route', () => {
    expect(nativeToRNSchema.safeParse({ type: 'selectTab' }).success).toBe(false);
    expect(nativeToRNSchema.safeParse({ type: 'selectTab', route: 42 }).success).toBe(false);
  });

  it('rejects an unknown message type', () => {
    expect(nativeToRNSchema.safeParse({ type: 'authToken', token: 'secret' }).success).toBe(false);
  });

  it('rejects a featureFlag missing required fields', () => {
    expect(nativeToRNSchema.safeParse({ type: 'featureFlag', key: 'x' }).success).toBe(false);
    expect(nativeToRNSchema.safeParse({ type: 'featureFlag', enabled: true }).success).toBe(false);
  });

  it('rejects a featureFlag with mistyped fields', () => {
    expect(nativeToRNSchema.safeParse({ type: 'featureFlag', key: 'x', enabled: 'yes' }).success).toBe(false);
  });

  it('rejects a config missing its payload', () => {
    expect(nativeToRNSchema.safeParse({ type: 'config' }).success).toBe(false);
  });

  it('rejects non-object / missing-discriminator input', () => {
    expect(nativeToRNSchema.safeParse(null).success).toBe(false);
    expect(nativeToRNSchema.safeParse('featureFlag').success).toBe(false);
    expect(nativeToRNSchema.safeParse({ key: 'x', enabled: true }).success).toBe(false);
  });
});
