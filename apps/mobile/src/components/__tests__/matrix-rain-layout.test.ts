import { describe, expect, it } from 'vitest';

import { CELL_WIDTH, MAX_COLUMNS, columnCount } from '../matrix-rain-layout';

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
