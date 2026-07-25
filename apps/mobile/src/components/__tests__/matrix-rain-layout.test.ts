import { describe, expect, it } from 'vitest';

import {
  CELL_WIDTH,
  GLYPHS,
  MAX_COLUMNS,
  columnCount,
  randomGlyph,
  stepEasing,
  trailBands,
} from '../matrix-rain-layout';

describe('columnCount', () => {
  it('never drops below one column, even below a single cell width', () => {
    expect(columnCount(0)).toBe(1);
    expect(columnCount(CELL_WIDTH - 1)).toBe(1);
  });

  it('floors the viewport width to whole columns', () => {
    expect(columnCount(CELL_WIDTH)).toBe(1);
    expect(columnCount(CELL_WIDTH * 2 - 1)).toBe(1);
    expect(columnCount(CELL_WIDTH * 2)).toBe(2);
    expect(columnCount(390)).toBe(Math.floor(390 / CELL_WIDTH)); // 24, a typical phone width
  });

  it('caps very wide viewports at MAX_COLUMNS', () => {
    expect(columnCount(MAX_COLUMNS * CELL_WIDTH)).toBe(MAX_COLUMNS);
    expect(columnCount(100_000)).toBe(MAX_COLUMNS);
  });
});

describe('GLYPHS / randomGlyph', () => {
  it('uses half-width katakana and digits only', () => {
    expect(GLYPHS).toMatch(/^[\uFF66-\uFF9D0-9]+$/);
    expect(GLYPHS).toContain('ｱ');
    expect(GLYPHS).toContain('ﾝ');
  });

  it('always returns a single glyph from the set', () => {
    for (let i = 0; i < 200; i++) {
      const g = randomGlyph();
      expect(g).toHaveLength(1);
      expect(GLYPHS).toContain(g);
    }
  });
});

describe('stepEasing', () => {
  it('quantizes progress into discrete row steps', () => {
    const ease = stepEasing(4);
    expect(ease(0)).toBe(0);
    expect(ease(0.24)).toBe(0);
    expect(ease(0.25)).toBe(0.25);
    expect(ease(0.6)).toBe(0.5);
    expect(ease(0.99)).toBe(0.75);
    expect(ease(1)).toBe(1);
  });

  it('never overshoots 1 and tolerates degenerate step counts', () => {
    expect(stepEasing(1)(0.5)).toBe(0);
    expect(stepEasing(1)(1)).toBe(1);
    expect(stepEasing(0)(1)).toBe(1);
    expect(stepEasing(10)(1)).toBe(1);
  });
});

describe('trailBands', () => {
  it('splits rows into bands that sum to the total', () => {
    for (let rows = 0; rows <= 40; rows++) {
      const { bright, mid, dim } = trailBands(rows);
      expect(bright + mid + dim).toBe(rows);
      expect(bright).toBeGreaterThanOrEqual(0);
      expect(mid).toBeGreaterThanOrEqual(0);
      expect(dim).toBeGreaterThanOrEqual(0);
    }
  });

  it('puts roughly 30/40/30 across bright/mid/dim', () => {
    expect(trailBands(10)).toEqual({ bright: 3, mid: 4, dim: 3 });
    expect(trailBands(20)).toEqual({ bright: 6, mid: 8, dim: 6 });
  });
});
