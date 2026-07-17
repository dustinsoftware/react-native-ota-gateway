/**
 * Pure layout math for the decorative {@link Sky} background, kept
 * dependency-free (no `react-native` import) so it is unit-testable without the
 * test-only RN stub. See `sky.tsx` for the rendered component.
 */

/** Number of parallax cloud layers drawn back-to-front. */
export const SKY_LAYERS = 3;

/** Duration (ms) of the slowest (farthest) layer's full traversal. */
const SLOWEST_DURATION_MS = 48_000;

/** Each nearer layer crosses the screen this much faster than the last. */
const DURATION_STEP_MS = 14_000;

/** Fewest clouds in a layer (the farthest); nearer layers add one each. */
const MIN_CLOUDS_PER_LAYER = 2;

export type CloudLayerConfig = {
  /** 0 = farthest/back, SKY_LAYERS-1 = nearest/front. */
  index: number;
  /** Time in ms for the layer to scroll one screen width; smaller = faster. */
  durationMs: number;
  /** Layer opacity: far layers are fainter (atmospheric depth). */
  opacity: number;
  /** Cloud size multiplier: far layers are smaller. */
  scale: number;
  /** Vertical offset (px) of the layer's cloud band. */
  top: number;
  /** Number of clouds evenly spaced across one screen width. */
  cloudCount: number;
};

/**
 * Deterministic parallax layer configs for a viewport of `width` x `height`.
 * Nearer layers (higher index) are larger, more opaque, lower on screen, and
 * move faster, which reads as depth. Deterministic so it can be unit-tested.
 */
export function cloudLayers(width: number, height: number): CloudLayerConfig[] {
  const safeHeight = Math.max(1, height);
  return Array.from({ length: SKY_LAYERS }, (_, index) => {
    const depth = SKY_LAYERS > 1 ? index / (SKY_LAYERS - 1) : 0; // 0 far .. 1 near
    return {
      index,
      durationMs: SLOWEST_DURATION_MS - index * DURATION_STEP_MS,
      opacity: 0.5 + depth * 0.45,
      scale: 0.6 + depth * 0.6,
      top: safeHeight * (0.08 + index * 0.2),
      cloudCount: MIN_CLOUDS_PER_LAYER + index,
    };
  });
}

/**
 * Evenly spaced x offsets (px) for `count` clouds across `width`. The last slot
 * is left open so the strip tiles seamlessly when repeated for the scroll loop.
 * Guards `count` to at least 1.
 */
export function cloudPositions(width: number, count: number): number[] {
  const safeCount = Math.max(1, Math.floor(count));
  const spacing = width / safeCount;
  return Array.from({ length: safeCount }, (_, i) => i * spacing);
}
