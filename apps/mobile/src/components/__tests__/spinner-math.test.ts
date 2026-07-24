import { describe, expect, it } from 'vitest';

import {
  accumulateAngle,
  angularVelocityFromLinear,
  normalizeAngleDelta,
  pointerAngle,
  clampVelocity,
  decayVelocity,
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

describe('decayVelocity', () => {
  it('halves the velocity after one half-life', () => {
    // FRICTION=0.99999/ms has a ~69.3s half-life; assert the math, not the constant.
    const halfLifeMs = Math.log(0.5) / Math.log(0.99999);
    expect(decayVelocity(10, halfLifeMs, 0.99999)).toBeCloseTo(5, 5);
  });

  it('is frame-rate independent (two half-frames equal one full frame)', () => {
    const oneStep = decayVelocity(10, 32, 0.999);
    const twoSteps = decayVelocity(decayVelocity(10, 16, 0.999), 16, 0.999);
    expect(twoSteps).toBeCloseTo(oneStep, 10);
  });

  it('preserves sign and leaves zero at zero', () => {
    expect(decayVelocity(-10, 100, 0.999)).toBeLessThan(0);
    expect(decayVelocity(0, 100, 0.999)).toBe(0);
  });
});

describe('clampVelocity', () => {
  it('passes through values inside the bound', () => {
    expect(clampVelocity(12.5, 60)).toBe(12.5);
    expect(clampVelocity(-12.5, 60)).toBe(-12.5);
  });

  it('clamps both signs to the bound (the tiny-radius release case)', () => {
    expect(clampVelocity(50000, 60)).toBe(60);
    expect(clampVelocity(-50000, 60)).toBe(-60);
  });
});
