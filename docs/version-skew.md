# OTA Version Skew

OTA updates ship JS on a different cadence than the host binary, so at any
moment real devices run **mismatched pairs**: a newer JS bundle on an older
host, or (briefly, after an app-store update) a newer host running a
previously-downloaded older bundle. Every contract that crosses the JS/native
boundary -- message types, initial-property keys, saved-state slices, native
modules, the update protocol itself -- must survive both directions of skew.

This document has two distinct parts. **Part 1 describes what the template
does today** (verified against the code; keep it in sync). **Part 2 is design
guidance for the skew scenarios the template does NOT yet handle** -- graceful
degradation on a slightly-older host, and the "app update required" gate for
the cases where a forced update is unavoidable. Nothing in Part 2 is
implemented here; it is written down so an implementation ports the pattern
rather than inventing one.

## Part 1 -- current behavior (implemented)

### The hard fence: `runtimeVersion`

`app.json` pins `runtimeVersion` (currently `"1"`), and each export stamps it
into the stored manifest. The manifest route
(`src/app/api/v2/updates/manifest+api.ts`) compares the stored value against
the client's `expo-runtime-version` header and returns **204 (no update)** on
any mismatch.
Two properties follow:

- **Old hosts freeze; they do not break.** A host whose runtime version no
  longer matches simply stops receiving updates and keeps running the last
  bundle it downloaded. Freezing is the default failure mode everywhere in
  this design -- a stale-but-working app beats a broken one.
- `runtimeVersion` must be bumped on ANY native-contract break: a native
  module added/removed/changed in the brownfield artifact, an expo-updates or
  RN upgrade with ABI impact, a change to how the host boots the runtime.
  Bumping it orphans every host in the field until they take an app-store
  update -- which is exactly why the *soft* mechanisms in Part 2 exist: the
  bump is the last resort, not the tool of first resort.

### Code-signing certificate rotation

The manifest code-signing certificate (see
[ota-updates.md](./ota-updates.md#code-signing)) is baked into the binary at
build time, so a host **verifies against the certificate it shipped with,
forever**. Rotating the signing key therefore behaves exactly like the
`runtimeVersion` fence:

- A new certificate requires a **new binary**. Hosts already in the field cannot
  learn a new public key over the air.
- If you re-sign updates with a new key, hosts built against the old certificate
  **reject the newly-signed manifest and freeze** on their current bundle -- they
  do not break. Same freeze-not-break polarity as a runtime mismatch.

Practically: rotate the key only alongside a `runtimeVersion` bump / app-store
release, and -- if old `runtimeVersions` must keep receiving updates -- keep
signing those with the **old** key until their population has drained.

### Fail-open update gating

`OtaGate` (`src/components/ota-gate.tsx`) blocks first render only when the last
OTA attempt is missing or >24h old (once per 24h, once per JS runtime), and
**falls through to the current bundle on any check failure** (offline, server
error).
A skew-handling design must preserve this polarity: the only screen that may
ever hard-block is the deliberate update-required gate of Part 2, never an
accidental one.

### Tolerant bridge contracts

Skew-tolerance already exists at the message bridge, by convention:

- Both hosts parse bridge messages defensively and **ignore unknown or
  malformed types** (`BrownfieldBootstrap.parseMessage` returns nil;
  Android's `BrownfieldMessageDispatcher.parseMessage` returns null). A newer bundle posting a message type an
  older host does not know is silently dropped -- degraded, not crashed.
- Native -> RN messages cross a Zod boundary (schema in
  `src/brownfield/message-bridge.types.ts`, enforced by the `safeParse` guard
  in `message-bridge.native.ts`); invalid shapes are dropped.
- Saved-state slices are dropped, never propagated, when malformed
  (`HostStateStore.kt` / `HostStateStore.swift` readers, and
  `hydrateHostSavedState` on the JS side).

The corollary is an evolution rule: **contract changes must be additive**.
Never rename or repurpose a message type, property key, or state-slice field;
add a new one and keep reading the old one for a dual-read window. The drift
guard (`plugins/__tests__/drift-guard.test.ts`) pins the literals
across the three layers *in-repo*, which catches renames at PR time -- but it
cannot see runtime skew between a deployed bundle and an installed host. The
tolerant-reader convention is what covers the runtime gap.

### What "the host" already tells JS

The host publishes its environment selection before RN boots
(`modules/host-environment`) and passes `initialUrl` + `savedStateJson` as
initial properties. Notably absent -- and needed for Part 2 -- is any
statement of the host's **build version or capabilities**.

## Part 2 -- design guidance (NOT implemented)

The scenarios below are ordered from cheapest to most disruptive. Reach for
the first rung that solves the problem; the forced update is the bottom of the
ladder, not the top.

### Scenario A: JS newer than host, contract still compatible (the default)

Handled entirely by Part 1's conventions: additive contracts + tolerant
readers. No new mechanism. The discipline is in review, backed by the drift
guard; nothing to build.

### Scenario B: JS newer than host, feature needs a host capability the old
host lacks (conditional fallback)

Example shape: a bundle ships a screen whose button posts a `navigate`
destination the installed host does not handle yet. Today that button would
silently do nothing (dropped message) -- degraded, but confusing.

Design: **host capability advertisement + JS feature gating.**

- The host would add two NEW initial properties to every mounted surface
  (alongside the existing `initialUrl`/`savedStateJson`): `hostBuild` (a
  monotonic build number) and
  `hostCapabilities` (a string array, e.g.
  `["navigate:settings", "saveState", "analytics"]`). A capability string is
  appended when the host ships the handler and never removed while the
  handler exists.
- JS exposes `hasHostCapability(name)` from the brownfield runtime module,
  hydrated the same way `hydrateHostSavedState` is (in the entry's mount
  initializer, before first render). Absent properties -- an old host that
  predates the mechanism -- mean *no* capabilities beyond the launch-era
  baseline, which is itself the first capability floor.
- Screens gate on capabilities, not on version numbers, and degrade
  visibly-but-gracefully: hide the "Open native Settings" affordance, or
  render the fallback (e.g. web view) instead of the native detour. Version
  numbers are for telemetry and the matrix below; **behavior branches on
  capabilities** so the checks stay truthful when features ship out of order.
- The drift guard extends to pin capability strings the same way it pins
  message types.

This is the "host is at a slightly older version" answer: the new bundle runs
everywhere, and only the affordances the old host cannot honor disappear.

### Scenario C: a bundle must never reach old hosts (server-side
compatibility matrix)

Capability gating keeps one bundle working on many hosts. Sometimes that is
not worth the complexity -- a bundle may simply *require* a host floor.
Design: teach the **manifest route** to select per host, not just per runtime
version.

- The host bakes its build number into the update-request headers
  (expo-updates supports extra request headers via its configuration; the
  `withBrownfieldUpdates` plugin is the natural place to inject
  `expo-runtime-version`'s sibling, e.g. `x-host-build`).
- Each exported update would carry a `minHostBuild` in the stored manifest
  (stamped at export time from a config field).
- The route serves the **newest update whose `minHostBuild` <= the caller's
  build**. The storage half of this is NOW REAL: the manifest store retains a
  version-indexed set of updates with per-environment channel pointers and an
  `OTA_UPDATE_PIN` override (rollback/canary), per
  [ota-updates.md](./ota-updates.md). What remains design-only here is the
  `minHostBuild` field and the per-host-floor selection itself.
- An old host then keeps *receiving updates* -- the newest ones compatible
  with it -- rather than freezing at whatever it had when the floor moved.
  Freezing (Part 1) remains the behavior only when no compatible update
  exists at all.

### Scenario D: the frozen bundle can no longer function (update required)

Eventually an old pairing must be retired: a server API sunset, a security
fix, a contract break too deep to dual-read. Forced updates are hostile UX --
they should be rare, telegraphed, and soft before they are hard.

- **The gate must predate the break.** The update-required screen renders
  from the OLD bundle on the OLD host -- you cannot retroactively add a kill
  screen to bundles already in the field. Ship the mechanism (a
  `minSupported` check + gate component wired into `OtaGate`'s flow) long
  before the first time it is needed, dormant.
- **Signal, server-side:** the manifest route (or a small companion config
  endpoint the gate polls) would return a support verdict for the caller's
  `runtimeVersion`/`hostBuild` pair: `ok`, `deprecated` (soft), or
  `unsupported` (hard). Verdicts live in server config, not in shipped code,
  so the decision to retire a pairing is an ops action with no deploy.
- **Soft first:** `deprecated` renders a dismissible nag ("update for the
  latest features") for a configured window -- days or weeks -- while
  telemetry shows the population draining. `unsupported` renders the blocking
  screen: explanation, an "update" button that asks the host to open the
  store listing (a `navigate` destination -- which itself must be a
  capability every host has carried since the gate shipped), and nothing
  else.
- **Fail open on ambiguity.** Offline or erroring verdict checks render the
  app, exactly like `OtaGate` today. A user on a plane must never be locked
  out by a gate that could not phone home. Hard-gating is only ever the
  result of an explicit, fresh `unsupported` verdict.
- **The native fallback still exists.** For screens ported behind
  flag-gated native fallbacks (the product pattern), the cheapest "forced
  update" is often no gate at all: flip the screen's kill-switch off for old
  cohorts and let the native implementation carry them until they update.

### Testing skew (when any of this is implemented)

Skew scenarios are testable in this template without an app store:

- **Old-host simulation:** build the host at pin N, export/serve bundle N+1 --
  assert capability-gated affordances hide, nothing crashes, unknown messages
  drop (extend the Maestro suite with a `verify-skew-*` flow pair).
- **Freeze path:** bump `runtimeVersion` in an export and assert the host
  keeps its current bundle (manifest 204) and stays functional.
- **Gate path:** point the verdict config at `deprecated`/`unsupported` and
  assert the nag/block screens, the store-link `navigate` message, and the
  fail-open behavior with the gateway stopped.
- Unit-test the manifest-route matrix the same way the route is tested today
  (`src/app/api/v2/updates/__tests__/manifest-route.test.ts`).

## Related docs

- [ota-updates.md](./ota-updates.md) -- the update protocol, manifest route,
  and reload contract this builds on.
- [brownfield.md](./brownfield.md) -- the message bridge, host-state seam, and
  navigate seam whose contracts skew stresses.
- [configuration.md](./configuration.md) -- environment/gateway selection.
