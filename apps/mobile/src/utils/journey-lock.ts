/**
 * The OTA journey lock: screens mark the spans where a reload must never land
 * (a checkout funnel, a form mid-submit), and `reloadApp` defers the restart
 * until the last journey ends instead of yanking the runtime mid-flow.
 *
 * Deliberately tiny: a module-global depth counter plus at most ONE pending
 * reload thunk (reloads are idempotent -- "restart into the newest update" --
 * so queuing more than one would only restart twice). Downloads are NOT
 * gated, only the restart: `checkAutomatically: ALWAYS` keeps fetching in the
 * background and the deferred reload applies the moment the journey ends.
 *
 * Nothing in the demo app locks a journey yet -- this is the seam the
 * storefront plan's checkout funnel (gap G7 in docs/storefront-demo-plan.md)
 * consumes. Screens use it as:
 *
 *   useEffect(() => { beginJourney(); return endJourney; }, []);
 */
let activeJourneys = 0;
let pendingReload: (() => void | Promise<void>) | null = null;

/** Enter a reload-unsafe span. Re-entrant: nested journeys stack. */
export function beginJourney(): void {
  activeJourneys += 1;
}

/** Leave a reload-unsafe span; flushes a deferred reload when the last ends. */
export function endJourney(): void {
  activeJourneys = Math.max(0, activeJourneys - 1);
  if (activeJourneys === 0 && pendingReload !== null) {
    const flush = pendingReload;
    pendingReload = null;
    void flush();
  }
}

export function isJourneyActive(): boolean {
  return activeJourneys > 0;
}

/**
 * Remember a reload to run once no journey is active (replacing any earlier
 * pending one). Only `reloadApp` should call this.
 */
export function deferReloadUntilIdle(reload: () => void | Promise<void>): void {
  pendingReload = reload;
}

/** Test-only reset -- the counter is module-global. */
export function resetJourneyLockForTests(): void {
  activeJourneys = 0;
  pendingReload = null;
}
