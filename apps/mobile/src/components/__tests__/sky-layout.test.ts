import { describe, expect, it } from 'vitest';

import { SKY_LAYERS, cloudLayers, cloudPositions } from '../sky-layout';

describe('cloudLayers', () => {
  const layers = cloudLayers(390, 800);

  it('produces one config per parallax layer', () => {
    expect(layers).toHaveLength(SKY_LAYERS);
    expect(layers.map((l) => l.index)).toEqual([0, 1, 2]);
  });

  it('moves each layer at a distinct speed, nearer layers faster', () => {
    const durations = layers.map((l) => l.durationMs);
    expect(new Set(durations).size).toBe(durations.length); // all distinct
    for (let i = 1; i < durations.length; i++) {
      expect(durations[i]).toBeLessThan(durations[i - 1]);
    }
    expect(durations.every((d) => d > 0)).toBe(true);
  });

  it('keeps nearer layers larger and more opaque', () => {
    for (let i = 1; i < layers.length; i++) {
      expect(layers[i].scale).toBeGreaterThan(layers[i - 1].scale);
      expect(layers[i].opacity).toBeGreaterThan(layers[i - 1].opacity);
    }
    expect(layers.every((l) => l.opacity > 0 && l.opacity <= 1)).toBe(true);
  });

  it('places each cloud band within the viewport height', () => {
    for (const layer of layers) {
      expect(layer.top).toBeGreaterThanOrEqual(0);
      expect(layer.top).toBeLessThan(800);
    }
  });

  it('guards a zero-height viewport without producing NaN tops', () => {
    for (const layer of cloudLayers(390, 0)) {
      expect(Number.isFinite(layer.top)).toBe(true);
      expect(layer.top).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('cloudPositions', () => {
  it('spaces clouds evenly across the width', () => {
    expect(cloudPositions(300, 3)).toEqual([0, 100, 200]);
  });

  it('always returns at least one position', () => {
    expect(cloudPositions(300, 0)).toEqual([0]);
    expect(cloudPositions(300, -5)).toEqual([0]);
  });

  it('returns as many positions as clouds requested', () => {
    expect(cloudPositions(390, 4)).toHaveLength(4);
  });
});
