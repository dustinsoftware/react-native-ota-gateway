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

/**
 * Glyph set from the 1999 film's "digital rain": half-width Japanese katakana
 * plus a few digits. Half-width forms keep the column monospaced.
 */
export const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789';

/** One glyph from {@link GLYPHS}, chosen uniformly at random. */
export function randomGlyph(): string {
  return GLYPHS.charAt(Math.floor(Math.random() * GLYPHS.length));
}

/**
 * Easing that quantizes progress into `steps` equal jumps, so an animated
 * translation lands exactly on grid rows instead of gliding between them --
 * the film's rain advances one character cell at a time.
 *
 * Returns 0 for `t < 1/steps`, then `k/steps` for each completed step `k`,
 * reaching 1 only at `t = 1`.
 */
export function stepEasing(steps: number): (t: number) => number {
  const n = Math.max(1, Math.floor(steps));
  return (t: number) => Math.min(n, Math.floor(t * n)) / n;
}

/**
 * Brightness bands for a trail of `rows` glyphs behind the head, brightest
 * first. Splits into bright (~30%), mid (~40%), and dim (~30%) row counts
 * that always sum to `rows`; empty bands are omitted.
 */
export function trailBands(rows: number): { bright: number; mid: number; dim: number } {
  const total = Math.max(0, Math.floor(rows));
  const bright = Math.round(total * 0.3);
  const mid = Math.round(total * 0.4);
  const dim = total - bright - mid;
  return { bright, mid, dim };
}
