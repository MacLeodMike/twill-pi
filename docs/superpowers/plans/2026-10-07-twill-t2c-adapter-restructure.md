# Twill T2c (adapter restructure: substrate + kind packages) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure twill-pi from a single extension into the layered architecture: `twill-pi` (the substrate — registry client, config, consumer identity, session-state machinery, no kind tools) + `twill-pi-workspace` (the workspace kind adapter — resolve/attach/claim tools + the write guard), with kind-qualified tool names.

**Architecture:** Two npm packages. `twill-pi` is a pi package that is ALSO a library (its substrate is importable via `exports`). `twill-pi-workspace` depends on it (`dependencies`) and registers the workspace tools under pi's `twill` tool namespace. Because pi loads installed packages with **separate module roots**, shared session state MUST NOT live in a module singleton — it lives in the host-provided `ctx` (see Global Constraints). The write guard moves to the workspace package (it's workspace-capability-shaped).

**Tech Stack:** TypeScript, vitest, pi package layout per pi docs (`packages.md`).

**Prior code being restructured:** `~/repos/twill-pi` @ `7d0bfc2` (the merged T2b extension). This plan MOVES code within and across the two repos; no behavior changes beyond the tool renames and the state-location change.

**Repos:**
- `~/repos/twill-pi` — becomes the substrate package.
- `~/repos/twill-pi-workspace` — NEW repo (user creates; the workspace kind adapter).

## Global Constraints

- **Tool names**: `twill_workspace_resolve`, `twill_workspace_attach`, `twill_workspace_claim` — kind-qualified per the user decision (2026-10-07). All three register under pi tool namespace `{name: "twill", description: "twill workspace fabric"}` so the model sees one grouped heading.
- **No module-singleton shared state across packages.** Pi loads installed packages with separate module roots (packages.md), so `twill-pi-workspace` importing `twill-pi`'s module would get a DIFFERENT instance than pi's loaded extension. Shared state therefore lives in one of two places: (a) `pi.appendEntry` / session entries for transcript-durable state, or (b) a per-tool-call fresh read. The adapter's active workspace is session state — store it in a session entry (or recompute per call); do NOT keep it in a module-level closure shared across packages.
- **Substrate exports** (`twill-pi`'s `exports` map): `loadConfig`, `consumerFromConfig`, `RegistryClient`, `RegistryError`, the resolve wire types + parser, and a generic `KindSessionState<T>` helper (per-kind attach state held by the CONSUMING package, in ITS OWN closure — the substrate provides the shape, not a shared instance).
- **`twill-pi` keeps its own extension entrypoint** (it remains a loadable pi extension) but registers only a `/twill` status command (registry health + configured endpoint) — no kind tools.
- **The write guard is workspace-shaped** and moves to `twill-pi-workspace` entirely (substrate has no guard concept).
- **Peer/host packages** per pi docs: `typebox` is host-provided — `peerDependencies: {"typebox": "*"}`, never in `dependencies`.
- **Behavior preservation**: every T2b behavior (cold-directs-to-claim, RWO advisory, claim-and-poll, guard containment rules, conservative-allow bash scanning) survives unchanged; only names and module boundaries move.

## Review Focus

1. **Both packages loaded and the workspace tool invoked** — the tool must read ITS OWN package's session state, not a stale cross-import. The integration test must catch accidental module-singleton sharing. → Task 3.
2. **`twill-pi` loaded WITHOUT `twill-pi-workspace`** — the `/twill` command works, no workspace tools exist, nothing errors. → Task 2.
3. **Rename completeness** — no lingering `twill_resolve`/`twill_attach`/`twill_claim` anywhere (tools, docs, tests, README). → Task 3 + final review.
4. **State surviving a pi `/reload`** — extension reload replaces the runtime; the active workspace must either be re-derivable from the transcript or explicitly cleared, never half-stale. → Task 3.
5. **The guard's containment behavior identical post-move** — the T2b guard tests move with the code and must pass unchanged (rename-only edits allowed). → Task 3.

---

### Task 1: Restructure `twill-pi` into the substrate package

**Files:**
- Modify: `~/repos/twill-pi/package.json` (name stays `twill-pi`; add `exports` map, `pi` manifest, `files`)
- Modify: `~/repos/twill-pi/index.ts` (factory now registers only `/twill`; tools removed)
- Move: `src/tools/*` OUT (they land in twill-pi-workspace in Task 3); keep `src/config.ts`, `src/registry-client.ts`
- Create: `src/session-state.ts` (the generic `KindSessionState<T>` helper)
- Test: adjust; tool tests move out in Task 3.

**Interfaces:**
- Consumes: the existing T2b code.
- Produces: the substrate exports listed in Global Constraints; a `/twill` command returning registry health + endpoint.

Behavior pins:
- `twill-pi` as a pi extension loads with no model-facing tools; `/twill` command works (Review Focus #2).
- `KindSessionState<T>`: `{attach(v: T): void; detach(): void; current(): T | null}` — a per-kind container the consuming package instantiates in ITS factory closure. The substrate provides the class, not an instance.
- The old `WorkspaceState` moves to twill-pi-workspace as `KindSessionState<AttachedWorkspace>` instantiation + the workspace-specific payload type.
- The `/twill` command handler does a live `GET /health` against the configured registry and reports it.

- [ ] **Step 1: failing tests** — config/client tests unchanged (they stay); new tests: `/twill` command handler returns health; `KindSessionState` attach/detach/current semantics; factory registers no tools (only the command + no tool_call handler).
- [ ] **Step 2-5: fail → implement → green → commit** — `t2c: twill-pi substrate — config/client/session-state + /twill command`

---

### Task 2: Scaffold `twill-pi-workspace` package

**Files:**
- Create: `~/repos/twill-pi-workspace/package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `~/repos/twill-pi-workspace/index.ts` (factory skeleton — registers nothing yet; imports the substrate)

**Interfaces:**
- Consumes: `twill-pi` (the package — via a `file:` dependency pointing at the local twill-pi checkout for development; the publish shape comes later).
- Produces: a loadable-but-empty pi extension package with the dependency wired.

Behavior pins:
- `package.json`: `name: "twill-pi-workspace"`, `dependencies: {"twill-pi": "file:../../twill-pi"}` (dev shape), `peerDependencies: {"typebox": "*"}`.
- The factory calls `loadConfig()` from the substrate and constructs its OWN `KindSessionState<AttachedWorkspace>` in its closure.
- Verify (Review Focus #1 groundwork): a test asserting the workspace package's state container is a different object than anything the substrate holds (i.e., state is per-package, not shared module state).

- [ ] **Step 1: failing tests** — substrate import works; state container is per-package; factory loads clean.
- [ ] **Step 2-5: fail → implement → green → commit** — `t2c: twill-pi-workspace package scaffold`

---

### Task 3: Move the workspace tools + guard into `twill-pi-workspace` (renamed)

**Files:**
- Move (from twill-pi): `src/tools/{resolve,attach,claim}.ts` + their tests → `~/repos/twill-pi-workspace/src/tools/` (renamed tools)
- Move: `src/guard.ts` + guard tests → `~/repos/twill-pi-workspace/src/guard.ts`
- Modify: `~/repos/twill-pi-workspace/index.ts` (register the three tools + guard)
- Move: the T2b integration test → adapted for the new package.

**Interfaces:**
- Consumes: the substrate's client/config/consumer + its own `KindSessionState<AttachedWorkspace>`.
- Produces: the complete workspace adapter.

Behavior pins:
- Tool renames: `twill_workspace_resolve`, `twill_workspace_attach`, `twill_workspace_claim` — every reference (tool names, descriptions, model-facing text, block reasons, the cold-directs-to-claim text, timeout messages, README) updated. grep for the old names must return zero outside git history (Review Focus #3).
- All three tools register with `namespace: {name: "twill", description: "twill workspace fabric"}`.
- Session state per Global Constraints: the attached workspace lives in the workspace package's OWN closure state (KindSessionState instance), NOT in a module import of twill-pi's state. The integration test must prove tool→guard state coherence within this package (attach via the tool, then the guard sees it) WITHOUT relying on any twill-pi module state (Review Focus #1).
- **Reload semantics** (Review Focus #4): on pi `/reload` the extension factory re-runs; the fresh closure starts UNATTACHED (same as T2b's session_shutdown semantics — the model must re-attach). Document this in the README's lifecycle section. Session entries for re-derivation are a later enhancement, explicitly out of scope.
- All T2b tests move and pass (rename-only edits).

- [ ] **Step 1: failing tests** — the moved test suites (resolve/attach/claim/guard/integration) run under the new package, updated for the new tool names.
- [ ] **Step 2-5: fail → implement → green → commit** — `t2c: workspace tools + guard moved into twill-pi-workspace (renamed)`

---

### Task 4: Cross-package integration test + READMEs

**Files:**
- Create: `~/repos/twill-pi-workspace/src/integration.test.ts` (the full chain: substrate-loaded + workspace-loaded → resolve → attach → guard blocks → shutdown)
- Modify: both READMEs.

**Interfaces:**
- Consumes: everything.

Behavior pins:
- The integration test loads BOTH factories (substrate factory then workspace factory, two separate closures sharing a stub host) and drives the Review-Focus-#1 chain: resolve → attach via `twill_workspace_attach` → guard blocks a sibling-repo write → session_shutdown → guard inert. This is the proof the layering works.
- `twill-pi` README: substrate role, exports, `/twill` command, "you want twill-pi-workspace for actual workspaces."
- `twill-pi-workspace` README: the old twill-pi README's user-facing content, updated for the renames + the dependency (`pi install` both packages).
- Both READMEs document the two-package install.

- [ ] **Step 1: failing integration test.**
- [ ] **Step 2-5: fail → implement → green → commit (both repos)** — `t2c: cross-package integration + READMEs`

---

## Self-review notes

- **Spec coverage:** no spec changes (this is adapter packaging); the protocol surface the tools consume is unchanged.
- **Type consistency:** substrate exports named identically in T1 (producer) and T3 (consumer); `KindSessionState<T>` defined once in the substrate.
- **Proportion:** 4 tasks; T1 and T3 carry the weight (substrate extraction, the move).
- **The one hard constraint** (no cross-package module singletons) is called out in Global Constraints, T2's pins, and T4's integration test — three places, because it's the failure mode this architecture is most prone to.
