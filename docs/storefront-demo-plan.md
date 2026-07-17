# Storefront Demo Plan (design only -- nothing here is implemented)

This document plans the most demanding React Native app this template could
host: a full **e-commerce storefront** with a production-grade user
experience. It is deliberately over-scoped. The goal is NOT to ship a shop --
it is to make every hard brownfield problem surface **here first**, in a
generic repo with fast iteration and a disposable domain, instead of surfacing
mid-port in a real product app. Every feature below earns its place by
stress-testing a seam, and the deliverable of each phase is as much the **gaps
register** (§6) as the feature itself.

Nothing in the FEATURE inventory exists yet. When any part is implemented,
move its description into the appropriate canonical doc (`brownfield.md`,
`ota-updates.md`, `configuration.md`, `version-skew.md`) and delete it from
here -- this file should shrink toward zero as the plan is consumed. A first
wave of prototype prerequisites has already landed (see the struck gaps in
§6): the versioned manifest store with channel pointers, the single Android
bridge dispatcher, host-state secret/size guards, per-tab navigation
restoration, and the OTA journey-lock seam.

## 1. Why e-commerce

E-commerce has the same complexity *shape* as most real host apps considering
a brownfield migration, expressed in generic terms:

| Complexity class | Storefront expression |
| --- | --- |
| Deep read-mostly catalog | home shelves, categories, search, product detail |
| Multi-step transactional funnel | cart -> address -> delivery -> payment -> confirm |
| Time-boxed holds | checkout inventory hold with a countdown |
| Identity + secure state | auth, 2FA, biometrics, tokenized payment methods |
| Loyalty/engagement | points, tiers, member barcode, rewards, inbox |
| Native-SDK islands | payment sheet, camera scanner, maps, push |
| Long-lived personalization | recently viewed, wishlists, preferences |

## 2. Experience bar

"Great UX" is a testable requirement here, not a slogan. Every screen ships
with:

- **Perceived speed**: skeleton loading (never spinners for content), cached
  first paint on revisit, optimistic mutations with visible rollback on
  failure.
- **Motion**: 60fps lists and gestures (Reanimated worklets, the fidget
  spinner's physics discipline generalized); shared-element transition from
  catalog card to product gallery; bottom sheets for filters/variants.
- **Resilience**: offline read cache, queued mutations where safe, an error
  taxonomy (retryable / terminal / degraded) rendered consistently, empty
  states designed rather than defaulted.
- **Inclusivity**: dark mode, dynamic type, screen-reader labels on every
  interactive element (which the Maestro suite then uses as selectors --
  accessibility and testability are the same work), RTL-safe layout.
- **Brownfield-native feel**: pushed surfaces use the host chrome
  (PushedScreenShell / nav-stack pattern), native back always behaves, and
  every journey survives the edge-case matrix the template already enforces
  (double-visit, double-tap, rotation, process death, reload-while-pushed).

## 3. Feature inventory

Surfaces are listed with their **host mounting** (shell tab, pushed, or
native detour) because the mounting decision is itself what gets tested.

### Shell tabs (joining Sky and Spinner)

Note: Sky and Spinner are not free to remove -- their routes are pinned by the
drift guard and the spinner carries the standing persistence Maestro flows
this plan's own exit criteria depend on. The storefront tabs therefore JOIN
the shell; retiring a demo tab later means consciously migrating its
drift-guard pins and flows, called out as its own commit.
1. **Home** -- hero carousel, personalized shelves ("picked for you",
   "recently viewed"), a deals rail with countdown timers, pull-to-refresh.
   Deep-link entry target.
2. **Browse** -- category tree, infinite product grid (virtualized), filter +
   sort bottom sheet, grid/list toggle (a persisted preference).
3. **Cart** -- line items with optimistic quantity steppers, promo-code
   entry, savings summary, cross-sell rail; badge count on the native tab.
4. **Account** -- profile, addresses, payment methods, orders, settings hub.
   (Developer and the More test menu remain as native tabs/rows for the
   existing verification suite.)

### Pushed RN surfaces
5. **Search** -- debounced suggestions, recent searches (persisted), results
   with facets; opened from a native search affordance in the shell toolbar.
6. **Product detail** -- image gallery (pinch/zoom), variant selection
   (size/color) with per-variant stock and price, reviews summary + list,
   related items, add-to-cart with animation, wishlist toggle.
7. **Checkout funnel** -- address entry with validation, delivery method,
   payment (native detour, below), order review, confirmation. Owns an
   **inventory hold**: a server-issued expiry the UI counts down against.
8. **Auth** -- sign in, sign up, 2FA code entry, guest-to-member cart merge.
9. **Order history / order detail / live tracking** -- status timeline,
   polling-driven updates, reorder.
10. **Loyalty** -- points balance with animated tier progress, rewards
    catalog, redemption flow, **member barcode** (wants a screen-brightness
    boost -- a capability request to the host).
11. **Wishlist(s)** -- multiple lists, move-to-cart, share (native share
    sheet via the bridge).
12. **Inbox** -- message center fed by push notifications; each message deep
    links to a product, order, or reward.
13. **Gift cards & promo codes** -- balance check, apply-at-checkout.

### Native detours (RN asks, host presents, result returns)
14. **Payment sheet** -- a mock provider behind a real contract: RN posts
    `presentPayment{orderId}`, the host shows a native sheet, a typed result
    (`authorized{token}` / `cancelled` / `failed{reason}`) comes back.
15. **Barcode scanner** -- in-store price check; camera stays native.
16. **Store locator map** -- full-screen map is a native detour; the RN store
    detail screen (hours, per-store stock) renders around it. (See gap G12
    for the embed-vs-detour decision this forces.)
17. **Biometric unlock** -- gate for payment-method reveal.

## 4. State model

The five state classes from the template's host-state work, applied:

| Class | Storefront examples | Mechanism |
| --- | --- | --- |
| Identity/session | auth token, member id | host-owned; synchronous native-module read + change events (gap G1) |
| Config/flags | feature flags, price locale, rollout cohort | boot injection + pushed updates over the bridge |
| Journey/transactional | cart, checkout progress, inventory hold | **server-authoritative**: a cart id / order-session id crosses world boundaries; both worlds fetch truth by id; the hold is an expiry *timestamp*, never a local timer |
| Ephemeral UI | scroll positions, filter selections, form drafts, gallery index | host-state seam checkpoints (existing), with per-slice TTL + schema version |
| Device prefs | grid/list toggle, recent searches, preferred store | host-state seam or native prefs, by write frequency |

Two rules carried over from the earlier analysis: **one writer per datum**
(RN posts commands like `logout` -- the type exists in the bridge contract
today with no host handler; under G1 the host would execute and broadcast),
and **no
bidirectional mirroring** of native singletons -- the cart exists once, on the
server, identified by id.

## 5. Phasing

Each phase ends the same way the template's scenario work did: Maestro flows
for the new surfaces PLUS the standing edge-case matrix, green in Shipping mode on
both platforms; docs moved from this plan into the canonical docs; a review
pass; one commit per scenario/feature slice.

- **Phase 1 -- Catalog spine (read-only).** Home, Browse, Product detail,
  Search. Surfaces: image pipeline and list-performance budgets (G14), deep
  links into RN (G5), skeleton/error/empty conventions, shared-element
  transitions, and the shell-tab additions (see the §3 note on the pinned
  Sky/Spinner invariants).
- **Phase 2 -- Cart (guest).** Server-side cart service in the gateway
  (fixture data), optimistic mutations, cross-surface cart badge (G6),
  process-death cart survival via cart id.
- **Phase 3 -- Identity.** Auth screens, session seam (G1), secure storage
  boundaries (G9), guest->member cart merge, logout propagation.
- **Phase 4 -- Checkout.** The funnel, inventory-hold expiry, payment detour
  contract (G2), OTA-safe funnels (G7), confirmation + order creation.
- **Phase 5 -- Engagement.** Loyalty, inbox + push routing (G4), analytics
  bridge (G3), wishlist + share detour.
- **Phase 6 -- Native-detour features.** Scanner, store locator, biometrics
  (G11, G12), screen-brightness capability, and the native-module cadence
  rehearsal (G8) if any RN-side native dependency is added.
- **Phase 7 -- Scale polish.** Localization + RTL (G13), accessibility
  automation, offline mutation queue (G15), performance regression gates,
  skew scenarios from `version-skew.md` Part 2 as they land.

Phase order is journey-boundary-driven on purpose: no phase splits a funnel
across worlds mid-flow.

## 6. Gaps register (the actual product of this plan)

Gaps the template is KNOWN not to cover today, each pinned to the phase that
will force it. When a gap is closed, record the design in the canonical docs
and strike it here.

| # | Gap | First forced by | Proposed shape |
| --- | --- | --- | --- |
| G1 | **Auth/session seam** -- no way for the host to hand RN a session, or for RN to observe logout | Phase 3 | host-backed native module (like `HostEnvironment`) with a synchronous token getter + change events; RN posts `logout` as a command |
| G2 | **Native detour with result** -- `navigate` is fire-and-forget; funnels need answers back | Phase 4 | request/response envelope over the bridge: `{requestId, destination, params}` out, `{requestId, result}` back, with timeout + cancelled-by-back semantics (the Activity-result contract, generalized) |
| G3 | **Analytics bridge** -- the `analytics` message type exists but no host sink consumes it, so posted events are dropped host-side | Phase 5 | fan received `analytics` messages to a host sink; a funnel is only portable if its measurement ports with it |
| G4 | **Push -> RN routing** -- a notification cannot open an RN surface | Phase 5 | host resolves the notification to a route and mounts/pushes with `initialUrl`; needs a route allow-list + cold-start ordering rules |
| G5 | **External deep links into RN** -- host deep-link handlers know nothing of RN routes | Phase 1 | same route-resolution table as G4; one registry, two entry points |
| G6 | **Cross-surface reactive state** -- a pushed PDP adds to cart; the shell's Cart tab badge is native and stale | Phase 2 | host-state is snapshot-at-mount by design; badges need a live channel: either bridge events the host listens to, or the host polls the cart service. Decide once, document the boundary between snapshot state and live state |
| G7 | ~~OTA-safe funnels~~ **mechanism landed** (`src/utils/journey-lock.ts`: begin/endJourney + deferred reload, unit-tested) | Phase 4 | remaining: the checkout funnel actually consuming it (beginJourney on entry, endJourney on completion/abandon) |
| G8 | **Native-module cadence** -- adding any RN native dependency (maps, mmkv, biometrics) changes the artifact ABI | Phase 6 | rehearsed procedure: add module -> bump `runtimeVersion` -> host re-pin -> skew freeze verified for old hosts (per `version-skew.md`); the demo should do this at least once ON PURPOSE |
| G9 | ~~Secure-data boundaries~~ **largely landed** (`checkpointHostState` refuses secret-shaped names + oversized slices, unit-tested; native writers cap size) | Phase 3 | remaining: SecureStore-only storage paths for actual secrets, and log hygiene |
| G10 | **Form-draft persistence at scale** -- checkout drafts are bigger and more sensitive than a spinner slice | Phase 4 | per-slice schema version + TTL (nav-restore now demonstrates both), plus G9 filtering; the slice ceiling is set (16KB, enforced both sides) -- remaining: whole-store injection may need per-surface scoping as slices multiply |
| G11 | **Capability advertisement** -- brightness boost, biometrics, share sheet vary by host version | Phase 6 | `hostCapabilities` from `version-skew.md` Part 2; the demo becomes its first consumer |
| G12 | **Embedded native views vs detours** -- a map INSIDE an RN screen (vs a full-screen detour) means a native component in the artifact | Phase 6 | decide the policy: detours default, embedding only with an explicit ADR; if embedding, it exercises G8 |
| G13 | **Localization/RTL** -- no i18n story exists; hosts and RN must agree on locale | Phase 7 | host injects locale at mount; RN owns strings; RTL snapshot flows in Maestro |
| G14 | **Performance budgets** -- no TTI/frame-rate gates; catalog lists will find the ceiling | Phase 1 | measured budgets (cold TTI, list scroll frame drops) recorded per phase; regression = failed exit criteria |
| G15 | **Offline mutation queue** -- optimistic writes need somewhere to live through a tunnel | Phase 7 | scope deliberately small: reads cache freely; queued writes only for idempotent, low-stakes mutations (wishlist), never money |
| G16 | ~~Multi-update retention + rollout pointers~~ **landed** (storeVersion-2 store: retained updates, per-env channel pointers, `OTA_UPDATE_PIN`; see [ota-updates.md](./ota-updates.md)) | Phase 4+ | remaining: percentage rollouts (cohort bucketing) and per-host-floor (`minHostBuild`) selection |

## 7. Non-goals

- **No real commerce**: mock catalog/cart/payment services live in the
  gateway server with fixture data; the payment "provider" is a fake behind
  the real G2 contract. No real PII, no real money, ever.
- **No product branding**: the domain stays generic (products, stores,
  rewards); tenant-specific behavior is out of scope for this repo.
- **Not a component library**: UI polish serves the seams; reusable design
  systems are a product concern.
- **Web parity is best-effort**: web/standalone keep working (the bridge
  no-ops), but the demo optimizes for the brownfield hosts.

## Related docs

- [brownfield.md](./brownfield.md) -- the seams (host-state, navigate,
  message bridge) this plan builds on.
- [version-skew.md](./version-skew.md) -- capability advertisement, manifest
  matrix, and update-required designs that several gaps consume.
- [ota-updates.md](./ota-updates.md) -- the update pipeline the funnel-safety
  work (G7) must respect.
- [development-workflow.md](./development-workflow.md) -- the runtime-mode and
  Maestro discipline every phase exits through.
