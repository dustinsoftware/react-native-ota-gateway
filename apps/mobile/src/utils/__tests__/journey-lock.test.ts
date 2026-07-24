import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginJourney,
  deferReloadUntilIdle,
  endJourney,
  isJourneyActive,
  resetJourneyLockForTests,
} from '../journey-lock';

/**
 * The OTA journey lock: reloads must never land mid-funnel. Pins the
 * re-entrant depth counting, the deferred-flush-on-idle behavior, and the
 * replace-not-queue semantics for pending reloads.
 */
describe('journey-lock', () => {
  beforeEach(() => {
    resetJourneyLockForTests();
  });

  it('is idle by default and active while any journey is open', () => {
    expect(isJourneyActive()).toBe(false);
    beginJourney();
    expect(isJourneyActive()).toBe(true);
    endJourney();
    expect(isJourneyActive()).toBe(false);
  });

  it('is re-entrant: nested journeys keep the lock until the LAST one ends', () => {
    beginJourney();
    beginJourney();
    endJourney();
    expect(isJourneyActive()).toBe(true);
    endJourney();
    expect(isJourneyActive()).toBe(false);
  });

  it('flushes a deferred reload exactly once, when the last journey ends', () => {
    const reload = vi.fn();
    beginJourney();
    deferReloadUntilIdle(reload);
    expect(reload).not.toHaveBeenCalled();

    endJourney();
    expect(reload).toHaveBeenCalledTimes(1);

    // The pending slot is cleared: another journey cycle must not re-fire it.
    beginJourney();
    endJourney();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('replaces (not queues) an earlier pending reload -- reloads are idempotent', () => {
    const first = vi.fn();
    const second = vi.fn();
    beginJourney();
    deferReloadUntilIdle(first);
    deferReloadUntilIdle(second);
    endJourney();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('unbalanced endJourney never goes negative (a later begin still locks)', () => {
    endJourney();
    beginJourney();
    expect(isJourneyActive()).toBe(true);
  });
});
