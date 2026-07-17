import { describe, expect, it } from 'vitest';

import {
  accumulateAngle,
  angularVelocityFromLinear,
  normalizeAngleDelta,
  pointerAngle,
} from '../spinner-math';

const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;

describe('pointerAngle', () => {
  it('measures the angle about the given center', () => {
    expect(pointerAngle(10, 5, 5, 5)).toBeCloseTo(0); // due east
    expect(pointerAngle(5, 10, 5, 5)).toBeCloseTo(HALF_PI); // due south (y grows down)
    expect(pointerAngle(0, 5, 5, 5)).toBeCloseTo(Math.PI); // due west
    expect(pointerAngle(5, 0, 5, 5)).toBeCloseTo(-HALF_PI); // due north
  });
});

describe('normalizeAngleDelta', () => {
  it('leaves small deltas unchanged', () => {
    expect(normalizeAngleDelta(0)).toBeCloseTo(0);
    expect(normalizeAngleDelta(HALF_PI)).toBeCloseTo(HALF_PI);
    expect(normalizeAngleDelta(-HALF_PI)).toBeCloseTo(-HALF_PI);
  });

  it('wraps deltas that cross the +/-PI seam to the short way round', () => {
    // Pointer jumps from just under +PI to just over -PI: physically a tiny
    // positive step, not a near-full negative turn.
    const nearPositivePi = Math.PI - 0.1;
    const nearNegativePi = -Math.PI + 0.1;
    expect(normalizeAngleDelta(nearNegativePi - nearPositivePi)).toBeCloseTo(0.2);
  });

  it('collapses full and multiple turns', () => {
    expect(normalizeAngleDelta(TWO_PI)).toBeCloseTo(0);
    expect(normalizeAngleDelta(-TWO_PI)).toBeCloseTo(0);
    expect(normalizeAngleDelta(TWO_PI + HALF_PI)).toBeCloseTo(HALF_PI);
  });

  it('keeps results within (-PI, PI]', () => {
    for (let raw = -20; raw <= 20; raw += 0.25) {
      const d = normalizeAngleDelta(raw);
      expect(d).toBeGreaterThan(-Math.PI - 1e-9);
      expect(d).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });
});

describe('accumulateAngle', () => {
  it('adds the shortest-path delta to the running total', () => {
    expect(accumulateAngle(1, 0, HALF_PI)).toBeCloseTo(1 + HALF_PI);
  });

  it('accumulates past a full turn instead of wrapping', () => {
    // Walk the pointer around the circle in 8 eighth-turn steps; total should
    // be one full turn (2*PI), never collapsing back toward zero.
    const step = TWO_PI / 8;
    let total = 0;
    let previous = 0;
    for (let i = 1; i <= 8; i++) {
      const current = i * step;
      total = accumulateAngle(total, previous, current);
      previous = current;
    }
    expect(total).toBeCloseTo(TWO_PI);
  });

  it('accumulates negative rotation when dragged the other way', () => {
    let total = 0;
    total = accumulateAngle(total, 0, -HALF_PI);
    total = accumulateAngle(total, -HALF_PI, -Math.PI);
    expect(total).toBeCloseTo(-Math.PI);
  });
});

describe('angularVelocityFromLinear', () => {
  it('derives positive angular velocity for a clockwise (screen-space) flick', () => {
    // Pointer to the right of center (rx>0) moving down (vy>0) spins positively
    // in screen space (y down): omega = (rx*vy - ry*vx)/r^2.
    expect(angularVelocityFromLinear(10, 0, 0, 0, 0, 20)).toBeCloseTo(2);
  });

  it('flips sign when the linear velocity reverses', () => {
    expect(angularVelocityFromLinear(10, 0, 0, 0, 0, -20)).toBeCloseTo(-2);
  });

  it('ignores the radial (non-tangential) component of velocity', () => {
    // Pure outward motion along the radius contributes no rotation.
    expect(angularVelocityFromLinear(10, 0, 0, 0, 5, 0)).toBeCloseTo(0);
  });

  it('returns 0 at the exact center to avoid dividing by a zero radius', () => {
    expect(angularVelocityFromLinear(5, 5, 5, 5, 100, 100)).toBe(0);
  });
});
