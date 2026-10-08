# twill-pi embeds startProvider — implementation plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the homelab one-install story — twill-pi embeds the twill provider (`startProvider`) in-process, so installing the pi extension yields a registry client AND a provider with no separate daemon. Per `~/repos/twill/docs/superpowers/specs/2026-10-07-twill-localhost-provider.md` §2 + the provider plan's follow-on.

**Architecture:** twill-pi (the substrate) gains an optional `provider` config block; when present, the factory registers a `session_start` handler that starts the provider loop (via the `twill/provider` import) and a `session_shutdown` handler that stops it. The provider loop itself lives in the twill repo; twill-pi only adapts its config to `ProviderConfig` and manages the session-scoped lifecycle.

**Tech Stack:** TypeScript/Node, vitest, tsx. twill consumed as a `file:` dependency (dev shape, matching the twill-pi-workspace → twill-pi pattern).

**Specs (authoritative):** `~/repos/twill/docs/superpowers/specs/2026-10-07-twill-localhost-provider.md`; twill `src/provider/loop.ts` (`startProvider`, `ProviderConfig`, `ProviderHandle`); pi's extension lifecycle rule (no timers in the factory; `session_start`/`session_shutdown`).

---

## Global Constraints

- **pi lifecycle rule (load-bearing).** The factory starts NO processes/sockets/timers — it only registers handlers. The provider loop (a timer) starts from a `session_start` handler and stops from an idempotent `session_shutdown` handler. (pi docs: "Start long-lived resources from `session_start`"; "Close session-scoped resources from an idempotent `session_shutdown` handler.")
- **Config-gated, explicit.** The provider runs iff `twill-pi.json` carries a `provider` block. Absent → no provider, no session_start provider start, no timer. Bare installs unchanged. (Not auto-detected from a local registry URL — explicit over implicit.)
- **One registry.** The embedded provider talks to the same registry the substrate is configured with (`config.registry`, including the `TWILL_REGISTRY` env override). The provider block carries only `routes`/`parents`/`pollIntervalMs` — NOT its own registry.
- **Dev-shape dependency.** `twill` is a `file:` dependency pointing at the local twill repo. The import is `from "twill/provider"` (the exports map T2.5 added).
- **Fail-loud config.** A malformed `provider` block throws at load (config is fail-loud at load per the existing invariant), never a half-started provider.

## Review Focus

1. **No `provider` block** → factory registers only `/twill` and the lifecycle handlers are registered but inert (no provider started on session_start). No timer. → Task 2.
2. **A valid `provider` block** → on session_start, the provider starts with a `ProviderConfig` whose `registry` = the substrate's configured registry (not a hardcoded default) and `routes`/`parents` from the block. → Task 2.
3. **session_shutdown** → the provider's `stop()` is called exactly once (idempotent — a second session_shutdown / reload converges without double-stop). → Task 2.
4. **A malformed `provider` block** (missing parents, a route without a string `type`, non-array routes) → `loadConfig` throws loud at load, naming the file + field. → Task 1.
5. **End-to-end**: a real in-process twill registry + the factory (session_start fired) + a claim → the child workspace materializes and resolves. → Task 3.

---

### Task 1: the `provider` config block + twill dependency

**Files:**
- Modify: `package.json` (add `"dependencies": {"twill": "file:/home/example/repos/twill"}`)
- Modify: `src/config.ts` (parse + validate the optional `provider` block)
- Test: `src/config.test.ts`

**Interfaces:**
- `TwillPiConfig` gains `provider?: TwillPiProviderConfig` where `interface TwillPiProviderConfig { parents: string[]; routes: Route[]; pollIntervalMs?: number }`.
  - `Route` — import the type from `twill/provider` if re-exported; otherwise use a structural `Array<Record<string, unknown> & { type: string }>` and note the choice. (Check what `twill/provider` actually re-exports first.)
- `loadConfig` parses the block when present; validation is fail-loud at load (Review Focus #4): `provider` present but not a plain object → throw; `parents` missing / not a non-empty array of strings → throw; `routes` missing / not a non-empty array of route objects (each a record with a string `type`) → throw; `pollIntervalMs` present but not a positive number → throw. Absent `provider` → `config.provider === undefined`.

Behavior pins:
- Route objects pass through VERBATIM (the provider's exact-match binding needs them byte-identical to the route a claim carries).
- The existing scalar fields + the TWILL_REGISTRY override behavior are unchanged; the 43 current tests stay green.

Gate: `npx vitest run` + `npx tsc --noEmit` green.

---

### Task 2: session_start wiring + lifecycle (index.ts) + README

**Files:**
- Modify: `index.ts` (factory registers session_start/session_shutdown handlers)
- Modify: `README.md` (the provider config block + the embedded-provider story)
- Test: `index.test.ts` (or the existing factory test file)

**Interfaces:**
- A module-local (or extensionState) `providerHandle: ProviderHandle | null`, starting null.
- Factory: after registering `/twill`, register `pi.on("session_start", ...)` and `pi.on("session_shutdown", ...)`.
  - `session_start` handler: if `config.provider` is present AND `providerHandle === null`, build the `ProviderConfig` (`registry: config.registry`, `routes`, `parents`, `pollIntervalMs` when present, `onEvent` wired to pi logging) and call `startProvider`; store the handle. Idempotent (already-running → no-op).
  - `session_shutdown` handler: if `providerHandle !== null`, `providerHandle.stop()`; set `providerHandle = null`. Idempotent (already-stopped → no-op).
- `onEvent` routing: the provider emits one line per lifecycle event; route it to `console.log` (pi captures extension stdout) or the substrate's logging — pick the cleaner one and note the choice.
- Update the index.ts header comment: the "no processes/sockets/timers in the factory" invariant now reads "the factory registers handlers only; the provider (a timer) starts on `session_start`, stops on `session_shutdown`, per pi's lifecycle rule."

Behavior pins:
- **Testability without a real poll loop**: inject the `startProvider` dependency so the wiring is unit-testable — e.g. the factory reads an optional injected starter (a module-scope `setProviderStarterForTests` seam, or a factory second-argument with the real `startProvider` as the default — pick the cleaner one, noting pi calls the factory with exactly one argument so the default must be the real path). Tests: (RF1) no provider block → session_start starts nothing; (RF2) provider block → session_start calls the injected starter with the adapted ProviderConfig (registry from config.registry); (RF3) session_shutdown stops exactly once; a second shutdown is a no-op.
- session_start when the provider is already running (e.g. a second session_start after a switch) does NOT start a second loop.

Gate: `npx vitest run` + `npx tsc --noEmit` green.

---

### Task 3: end-to-end integration (embedded provider fulfills a claim)

**Files:**
- Test: `src/provider.integration.test.ts` (new)

**Interfaces:**
- Boot a REAL in-process twill registry (import `start` + `createServer` from the twill package — check what `twill`'s exports map exposes; if only `./provider` is exposed, add a `./registry` export to the twill repo OR import the deep path `twill/src/registry/server.js` — pick whichever the twill package supports, noting the choice) + a tmp git fixture (the twill repo's own e2e.test.ts at `~/repos/twill/src/provider/e2e.test.ts` has the fixture pattern).
- The full loop with the provider embedded via the factory's session_start: claim a cold workspace over HTTP (POST a Claim) → the embedded provider fulfills → the child Workspace appears + `ready:true` → `resolve(Workspace, <child>)` returns the child route. Review Focus #5.
- Use short poll intervals (config `provider.pollIntervalMs` small) + generous timeouts (tsx/git are slow).

Gate: `npx vitest run` green incl. the E2E; `npx tsc --noEmit` clean.

---

## Follow-on (noted, not built here)

- Installing twill-pi + twill-pi-workspace into `~/.pi/agent` and dogfooding the live claim→materialize→attach loop in a real pi session.
- Publish shape (a real semver `twill` package or a shared `@twill/provider` package) replacing the `file:` dev dep.
