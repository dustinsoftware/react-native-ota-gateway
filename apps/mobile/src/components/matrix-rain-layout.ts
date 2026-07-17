/**
 * Pure layout math for the decorative {@link MatrixRain} background, kept
 * dependency-free (no `react-native` import) so it is unit-testable without the
 * test-only RN stub. See `matrix-rain.tsx` for the rendered component.
 */

/** Horizontal cell size (px) -- one rain column per cell. */
export const CELL_WIDTH = 16;

/** Upper bound on columns, so a very wide window does not spawn hundreds of loops. */
export const MAX_COLUMNS = 60;

/** Number of rain columns for a viewport `width`: at least 1, at most {@link MAX_COLUMNS}. */
export function columnCount(width: number): number {
  return Math.min(MAX_COLUMNS, Math.max(1, Math.floor(width / CELL_WIDTH)));
}
