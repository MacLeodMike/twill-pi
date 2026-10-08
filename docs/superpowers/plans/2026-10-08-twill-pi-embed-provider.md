# twill-pi embeds startProvider — implementation plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the homelab one-install story — `twill-pi` embeds the twill provider (`startProvider`) in-process so installing the pi extension yields a registry client *and* a provider, no separate daemon. Per `~/repos/twill/docs/superpowers/specs/2026-10-07-twill-localhost-provider.md` §2 + the provider plan's follow-on.

**Architecture:** twill-pi (the substrate) gains an optional `provider` config block and an embedding seam that adapts its own config to the provider's `ProviderConfig` and runs the loop, stopped on `session_shutdown`. The provider code itself lives in the twill repo (`src/provider/loop.ts`); twill-pi consumes it as a dependency. This is the runtime-agnostic provider hosted by the substrate — the same loop a `twill provider` CLI process runs.

**Tech Stack:** TypeScript/Node, vitest, tsx. twill consumed as a `file:` dependency (dev shape).

**Specs:** `~/repos/twill/docs/superpowers/specs/2026-10-07-twill-localhost-provider.md` §2/§5; twill provider code `src/provider/loop.ts` (`startProvider`, `ProviderConfig`, `ProviderHandle`).

---

## Global Constraints

- **Config-gated, explicit.** The provider runs iff `twill-pi.json` carries a `provider` block. Absent block → no provider, no timer, bare installs unchanged. (Not "auto-detect a local registry" — explicit config over implicit guessing.)
- **The registry is shared.** The embedded provider talks to the same registry the substrate's config names (`config.registry`).
- **Dependency injection for tests.** The embedding seam takes an injectable `start` (defaulting to the real `startProvider`) so the wiring is unit-testable without a real registry/poll loop.
- **Lifecycle clean.** Factory starts the provider when configured; `session_shutdown` stops it (`handle.stop()`). The T2c "factory starts no processes/sockets/timers" comment is updated: that invariant held when there was no provider; the provider is the deliberate exception, gated on config.
- **One repo + one tiny twill touch.** All twill-pi work lands in ~/repos/twill-pi. The only twill-repo change is adding an `exports` map exposing `./provider` (done as a separate small twill commit before Task 1).

## Review Focus

1. **No `provider` block** → factory registers only `/twill`, no provider started, no timer, no stop handler needed. → Task 2.
2. **A `provider` block with valid routes+parents** → factory starts the provider with a `ProviderConfig` whose `registry` = the substrate's configured registry (not a hardcoded default), `routes`/`parents` from the block, `onEvent` wired. → Task 2.
3. **session_shutdown** → the provider's `stop()` is called exactly once. → Task 2.
4. **A malformed `provider` block** (missing parents, a route without a string `type`) → `loadConfig` throws loud at load (config is fail-loud at load per the T2c invariant), never a half-started provider. → Task 1.
5. **End-to-end**: a real in-process twill registry + the embedded provider + a claim → the child workspace materializes and resolves. → Task 3.

---

### Task 0: twill exposes the provider (twill repo, small additive commit)

**Files:** Modify `~/repos/twill/package.json` (add `exports`).
- Add: `"exports": { "./provider": "./src/provider/loop.ts" }`. Nothing else changes; twill is `private` and nothing imports it as a package yet, so an exports map restricts nothing in practice. Matches twill-pi's own `.ts`-target exports pattern (proven to load under pi's jiti).
- Gate: `npx vitest run` still green in twill; commit to main directly (trivial additive).

---

### Task 1: `provider` config block (twill-pi)

**Files:**
- Modify: `~/repos/twill-pi/package.json` (add `"dependencies": {"twill": "file:/home/example/repos/twill"}`)
- Modify: `~/repos/twill-pi/src/config.ts` (parse + validate the optional `provider` block)
- Test: `~/repos/twill-pi/src/config.test.ts`

**Interfaces:**
- `TwillPiConfig` gains `provider?: TwillPiProviderConfig` where `interface TwillPiProviderConfig { parents: string[]; routes: Route[]; pollIntervalMs?: number }` (`Route` imported type-only from `twill/provider`).
- `loadConfig` parses the block when present; validation is fail-loud at load (Review Focus #4): `provider` present but not an object / `parents` missing or not a non-empty string array / `routes` missing or not a non-empty array of route objects (each a record with a string `type`) / `pollIntervalMs` present-but-not-a-positive-number → throw naming the file + field. Absent `provider` → `config.provider === undefined`.

Behavior pins:
- Route objects pass through verbatim (the provider's exact-match binding needs them byte-identical to the route a claim carries).
- Existing config fields + TWILL_REGISTRY override behavior unchanged; the 43 current tests stay green.

Gate: `npx vitest run` + `npx tsc --noEmit` green.

---

### Task 2: the embedding seam + factory wiring (twill-pi)

**Files:**
- Create: `~/repos/twill-pi/src/provider.ts`
- Modify: `~/repos/twill-pi/index.ts`
- Test: `~/repos/twill-pi/src/provider.test.ts`, `~/repos/twill-pi/index.test.ts` (or factory.test.ts — match existing)

**Interfaces:**
- `startEmbeddedProvider(config: TwillPiConfig, start: typeof startProvider = startProvider): ProviderHandle | null` — `null` when `config.provider` is undefined (Review Focus #1); else builds `ProviderConfig { registry: config.registry, routes, parents, pollIntervalMs, onEvent }` (Review Focus #2 — registry from the substrate config) and calls `start`, returning the handle.
- Factory: when `startEmbeddedProvider` returns a handle, register `pi.on("session_shutdown", ...)` → `handle.stop()` exactly once (Review Focus #3). `onEvent` → `console.log` (pi captures extension stdout; the substrate has no per-event UI channel and notify-per-poll would be noise).
- Update the index.ts header comment: the "no processes/sockets/timers" invariant is now "…unless a `provider` block is configured — the embedded provider is the deliberate, config-gated exception."

Behavior pins:
- All wiring tests inject a fake `start` (DI seam) — no real poll loop in unit tests.
- `config.provider === undefined` → `startEmbeddedProvider` returns null, factory starts nothing.

Gate: `npx vitest run` + `npx tsc --noEmit` green.

---

### Task 3: integration test + README (twill-pi)

**Files:**
- Create: `~/repos/twill-pi/src/provider.integration.test.ts` (or extend an integration suite)
- Modify: `~/repos/twill-pi/README.md`

**Interfaces:**
- Integration (Review Focus #5): boot a REAL in-process twill registry (the twill package's `start` + `createServer` — importable from the file: dep for the test), a tmp git fixture, a twill-pi config with a `provider` block, the real `startEmbeddedProvider`. POST a claim (over HTTP) → the embedded provider fulfills → the child Workspace appears + `ready:true` → `resolve(Workspace, <child>)` returns the child route. This proves the homelab one-install loop closes with the provider embedded in the substrate.
- README: the `provider` config block (shape + a complete example), the embedded-provider story (one install = registry client + provider), the lifecycle (starts on load, stops on shutdown), and the explicit-config rule (no block → no provider).

Gate: `npx vitest run` + `npx tsc --noEmit` green; README config/signature match the code.

---

## Follow-on (noted, not built here)

- Installing twill-pi + twill-pi-workspace into `~/.pi/agent` and dogfooding the live claim→materialize→attach loop.
- The steady-state log-repetition and SIGTERM minors on the twill provider (ledger).
