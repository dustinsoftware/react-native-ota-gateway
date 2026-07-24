/**
 * Pure angle/velocity helpers for the {@link FidgetSpinner}. Each function is a
 * Reanimated worklet (the `'worklet'` directive) so it can be called from the
 * gesture callbacks on the UI thread, yet stays a plain, side-effect-free
 * function that Vitest can import and test directly (the directive is a no-op
 * string literal outside the worklets runtime). No `react-native` import.
 */

const TWO_PI = Math.PI * 2;

/** Angle (radians) of the point (x, y) about the center, via atan2. */
export function pointerAngle(x: number, y: number, centerX: number, centerY: number): number {
  'worklet';
  return Math.atan2(y - centerY, x - centerX);
}

/**
 * Wraps an angular delta into the shortest-path range (-PI, PI]. This is what
 * makes dragging across the +/-PI seam (e.g. from just under +180 to just over
 * -180) register as a small step rather than a near-full-turn jump.
 */
export function normalizeAngleDelta(delta: number): number {
  'worklet';
  let d = delta % TWO_PI;
  if (d <= -Math.PI) {
    d += TWO_PI;
  } else if (d > Math.PI) {
    d -= TWO_PI;
  }
  return d;
}

/**
 * Accumulated absolute rotation after the pointer moves from `fromAngle` to
 * `toAngle`. Adds the shortest-path (normalized) delta to `current` so total
 * rotation grows unbounded across many turns instead of wrapping.
 */
export function accumulateAngle(current: number, fromAngle: number, toAngle: number): number {
  'worklet';
  return current + normalizeAngleDelta(toAngle - fromAngle);
}

/**
 * Coast velocity after `dtMs` milliseconds under a per-millisecond
 * multiplicative friction factor. The FidgetSpinner's frame callback applies
 * this each frame (manual integration instead of withDecay, whose internal
 * stop-epsilon halts a slow spin abruptly).
 */
export function decayVelocity(velocity: number, dtMs: number, frictionPerMs: number): number {
  'worklet';
  return velocity * Math.pow(frictionPerMs, dtMs);
}

/**
 * Clamps a coast velocity to +/-maxVelocity. A center-adjacent release divides
 * by a tiny radius and can produce an absurd angular velocity; a persisted
 * slice could in principle carry one too, so resume paths clamp as well.
 */
export function clampVelocity(velocity: number, maxVelocity: number): number {
  'worklet';
  return Math.max(-maxVelocity, Math.min(maxVelocity, velocity));
}

/**
 * Angular velocity (radians/second) of a pointer moving with linear velocity
 * (velocityX, velocityY) at position (x, y) about the center. Derived from the
 * cross product of the radius vector and the velocity vector divided by the
 * squared radius, so it needs no frame timing. Returns 0 at the exact center
 * (undefined radius). This is what seeds the release inertia.
 */
export function angularVelocityFromLinear(
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  velocityX: number,
  velocityY: number,
): number {
  'worklet';
  const rx = x - centerX;
  const ry = y - centerY;
  const radiusSquared = rx * rx + ry * ry;
  if (radiusSquared === 0) {
    return 0;
  }
  return (rx * velocityY - ry * velocityX) / radiusSquared;
}
