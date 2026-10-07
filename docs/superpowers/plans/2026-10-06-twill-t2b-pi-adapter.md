# Twill T2b (pi adapter, `twill-pi`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `twill-pi`, the pi extension that is the fabric's first real consumer-adapter: resolve workspaces through a twill registry, attach them as path-scoped capabilities, and claim cold workspaces through the claim-and-poll loop.

**Architecture:** A pi extension (TypeScript, loaded by pi's jiti runtime — no build step) that registers three model-callable tools (`twill_resolve`, `twill_attach`, `twill_claim`) plus a `tool_call` event handler implementing the path-scoped write guard. The extension talks to the registry over HTTP only (the same contract the `twill` CLI consumes). State (the session's active workspace) is session-scoped, held in the extension factory closure and re-derivable from the transcript after reload.

**Tech Stack:** TypeScript (pi extension, jiti-loaded, no tsc emit); vitest for the test suite (run outside pi against a mock registry — the T1 registry's own test harness pattern: real `node:http` server on an ephemeral port).

**Specs (authoritative — read before implementing):**
- `~/repos/twill/docs/superpowers/specs/2026-10-04-twill-fabric-core.md` (rev 10) — §7 (resolution), §7.2 (descriptor), §8 (status surface), §9 (claims)
- `~/repos/twill/docs/superpowers/specs/2026-10-04-twill-workspace.md` (rev 10) — §4 (route types), §6 (cold-wake e2e loop)
- pi extension docs: `/home/linuxbrew/.linuxbrew/Cellar/pi-coding-agent/1.0.4/libexec/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (tool_call, registerTool, events)

**Sibling codebase (the contract implementation):** `~/repos/twill` — the registry this adapter talks to. The adapter MUST NOT import from it (pure HTTP consumer, same rule as the CLI).

## Global Constraints

- **Consumer tuple** (core §7.1): the adapter declares `agentKind: "pi"`, `agentLocation` from config (default `"workstation"`), `principal: "pi/<version>@<location>"` (self-declared, untrusted per core §5).
- **Descriptor contract** (core §7.2): `twill_resolve` returns the registry's ResolveResult verbatim to the model; the adapter reads `route`, `status`, `durable_id` from it.
- **Consumers MUST NOT execute preconditions** (core §6.3): `route.precondition.steps` are informational to the model, never executed by the adapter. The write guard and the claim loop are the adapter's only behaviors.
- **Claim shape** (core §9): `twill_claim` POSTs a Claim document per the T2a surface: parent = the resolved (existing) workspace; `spec.claim.principal` = the consumer principal; `claimedOn` = `{fingerprint, durable_id}` from the workspace document (fetched via `GET /<kind>/<name>` — the resolve descriptor does not carry fingerprint); `spec.claim.route` = the resolved route verbatim; parameters per the workspace's needs (`branch`, `worktreeName`).
- **Cold-wake loop** (workspace §6): after claiming, compute the expected child name `<parent-name>-<worktreeName>` when the claim carries worktree parameters; poll `resolve(Workspace, <childName>, consumer)` every 5–10s until `ready: true` (then attach the child) or timeout (default 10 min, configurable). No worktree parameters → keep polling the parent's name (the provider materializes the parent itself).
- **Write guard**: while a workspace is attached, `tool_call` events for `write`/`edit`/`bash` whose target paths escape the workspace root are blocked with a reason naming the root. `local` routes: the root is the route's `path` (with `~` expanded). The guard is advisory for non-local routes in v1 (an ssh route's path is remote — the guard can't see it; the model is told the boundary via the tool result, not enforced).
- **Path extraction**: `write`/`edit` carry a path argument directly; `bash` carries a command string — extract candidate paths conservatively (tokens that look like absolute paths or `~/…`); when in doubt, allow (the guard's job is catching the common escape, not parsing shell). This tradeoff is pinned and documented; it is NOT a sandbox.
- **Extension lifecycle** (pi docs): no processes/sockets/timers in the factory; the registry base URL and defaults come from config; `session_shutdown` clears the active workspace.
- **Registry config**: `TWILL_REGISTRY` env or `~/.pi/agent/twill-pi.json` (`{"registry": "http://…", "agentLocation": "workstation", "claimTimeoutMs": 600000, "pollIntervalMs": 7000}`).

## Review Focus

1. **A `write` call to `~/repos/other-repo/file.ts` while `payments-repo` is attached** — the classic worktree-escape. Must block with a reason naming the attached root. → Task 4.
2. **A `bash` call like `cd /tmp && make`** while attached — an escape through the shell. The guard extracts `/tmp`, sees it outside the root, blocks. → Task 4.
3. **Resolve on a cold workspace returns Attached-via-provisionable (ready:false)** — the model must be told *not* to treat this as attachable; `twill_attach` refuses cold workspaces and directs the model to `twill_claim`. → Task 2.
4. **Claim + poll where the provider never reports ready** — the loop times out, the claim is left in place (spec §6: visibility for operators), the tool result says so and tells the model how to release. → Task 5.
5. **A `tool_call` arriving while NO workspace is attached** — the guard must be inert (never block unattached sessions). → Task 4.

---

### Task 1: Extension scaffold + config + registry client

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `index.ts` (the extension entry — pi loads this)
- Create: `src/config.ts`
- Create: `src/registry-client.ts`
- Test: `src/registry-client.test.ts`

**Interfaces:**
- Consumes: the twill registry HTTP surface (T1+T2a).
- Produces:
  - `loadConfig(): TwillPiConfig` — `{registry: string; agentLocation: string; claimTimeoutMs: number; pollIntervalMs: number}` from `~/.pi/agent/twill-pi.json` + `TWILL_REGISTRY` env override (env wins). Defaults: registry `http://localhost:8080/twill/v1alpha1`, location `workstation`, timeout 600000, poll 7000.
  - `class RegistryClient` — `resolve(kind, name, consumer)`, `getDoc(kind, name)`, `createClaim(name, claimDoc)`, `releaseClaim(parentKind, parentName, claimName)` (via `GET /claims?parent=…&includeReleased=true` lookup + PATCH — the T2a CLI pattern), `listClaims(parentKind, parentName)`. All thin `fetch` wrappers returning parsed JSON; HTTP errors throw with the server's error body.
  - `consumerFromConfig(config): Consumer` — `{agentLocation, agentKind: "pi", principal: `pi/${version}@${config.agentLocation}`}`.

Behavior pins:
- The extension factory (`index.ts` default export) registers the tools in later tasks; for Task 1 it registers nothing but loads config and exposes it on a module-local (the tool bodies in later tasks close over it). No timers/sockets in the factory.
- Config file missing → defaults, no error. Malformed JSON → throw with the file path (fail loud at extension load).
- RegistryClient tests boot a real `node:http` server on an ephemeral port with canned responses (the T1 server.test.ts harness pattern), asserting request shapes (method, path, body) and response handling.

- [ ] **Step 1: failing tests** — config defaults; env override; malformed file throws; client resolve POSTs the right body to `/resolve` and parses the three result shapes; createClaim POSTs to `/Claim/<name>`; listClaims GETs `/claims?parent=…` with correct query encoding.
- [ ] **Step 2: run, verify fail.**
- [ ] **Step 3: implement.**
- [ ] **Step 4: run, verify pass + `tsc --noEmit` clean.**
- [ ] **Step 5: commit** — `t2b: extension scaffold + config + registry client`

---

### Task 2: `twill_resolve` + `twill_attach` tools

**Files:**
- Modify: `index.ts`
- Create: `src/tools/resolve.ts`, `src/tools/attach.ts`
- Create: `src/workspace-state.ts`
- Test: `src/tools/resolve.test.ts`, `src/tools/attach.test.ts`

**Interfaces:**
- Consumes: Task 1's `RegistryClient`, config.
- Produces:
  - `WorkspaceState` — the session's active workspace: `{name, durableId, root, route, claimedByAtAttach} | null` with `attach()`/`detach()`/`current()`. Session-scoped, lives in the factory closure.
  - `twill_resolve` tool — params `{kind, name}`; returns the ResolveResult verbatim as the tool result content (JSON text). On `Attached` with `status.ready: false`, the model-facing text explicitly says the workspace is cold and directs to `twill_claim` (Review Focus #3).
  - `twill_attach` tool — params `{kind, name}`; resolves, and: `NoMatch`/`Unreachable` → error result naming the reason; `ready: false` → refusal directing to `twill_claim` (Review Focus #3); `ready: true` → sets `WorkspaceState` (root = route.path with `~` expanded for local routes) and returns the attached summary. RWO advisory (workspace §3): if `status.claimedBy` is non-empty and none of the claims' `principal` equals our own principal, the attach SUCCEEDS but the result carries a visible warning naming the current claimants.

Behavior pins:
- Tool results carry `content` (model-facing text) and `details` (structured state) per pi's tool contract.
- Attaching a second workspace replaces the first (result notes the swap).
- `twill_attach` does NOT change pi's process cwd (an extension can't safely do that for the model's other tools); the workspace root is enforced by the Task-4 guard, and the model is told to use root-relative paths.

- [ ] **Step 1: failing tests** — resolve pass-through; cold-workspace message; attach refusal on cold; attach success sets state; RWO warning present when claimedBy has another principal; swap behavior.
- [ ] **Step 2-5: fail → implement → green → commit** — `t2b: twill_resolve + twill_attach tools`

---

### Task 3: `twill_claim` tool + the claim-and-poll loop

**Files:**
- Create: `src/tools/claim.ts`
- Modify: `index.ts`
- Test: `src/tools/claim.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: `twill_claim` tool — params `{name, branch?, worktreeName?, timeoutMs?}`. Flow per workspace §6: resolve the parent → GET the workspace document (for claimedOn fingerprint) → POST the claim → poll `resolve` on the child name (`<parent>-<worktreeName>` when worktreeName present, else the parent's own name) every `pollIntervalMs` until `ready: true` → on success, attach the resolved child (same path as `twill_attach`) and return the attached summary; on timeout, return an error result stating the claim remains visible (naming it) and how to release (Review Focus #4).

Behavior pins:
- The poll loop is async inside the tool's `execute()`; it must respect pi's `ctx.signal` (abort = stop polling, leave the claim, say so).
- Claim names: `claim-<parent>-<principal-sanitized>-<epoch>` (the T2a CLI convention).
- The claim's `route` field is the parent's resolved route **verbatim** (provider binding, §9).
- Timeout default from config (`claimTimeoutMs`); per-call `timeoutMs` overrides.
- A claim that fails POST (409 name collision, 422 claimedOn mismatch, 409 missing parent) surfaces the server's error body in the tool result.

- [ ] **Step 1: failing tests** — against a scripted mock registry: happy path (claim → child becomes ready on poll 3 → attached); timeout path (never ready → error result naming the claim, claim left in place); abort path; 409-on-create path. Use accelerated poll intervals (config injection).
- [ ] **Step 2-5: fail → implement → green → commit** — `t2b: twill_claim tool + claim-and-poll loop`

---

### Task 4: The path-scoped write guard (`tool_call` handler)

**Files:**
- Create: `src/guard.ts`
- Modify: `index.ts` (register the handler)
- Test: `src/guard.test.ts`

**Interfaces:**
- Consumes: `WorkspaceState` (Task 2).
- Produces: `guardToolCall(event, state): { block: true; reason: string } | undefined` — the `tool_call` handler. Blocks `write`/`edit`/`bash` calls whose extracted paths escape the attached root; returns undefined (allow) otherwise, and always allows when no workspace is attached (Review Focus #5).

Behavior pins:
- Path extraction: `write`/`edit` read the tool's path argument (`event.input.path` or the tool's declared path field — check pi's tool_call event shape in the docs). `bash` scans the command string for absolute paths and `~/` tokens (conservative: extract, check, allow on doubt — this is the documented tradeoff, NOT a sandbox).
- Root containment: path must equal-or-be-under the attached root after normalization (`~` expansion, `.`/`..` resolution via `path.resolve`).
- Block reason names the attached root and the offending path.
- Non-local route types (ssh, k8s-exec): guard is advisory — the handler logs/permits; the attached summary from Task 2 already tells the model the boundary. (A local-process guard cannot see a remote filesystem.)
- Symlink escapes are out of scope for v1 (documented).

- [ ] **Step 1: failing tests** — Review Focus #1 (write to sibling repo blocked), #2 (`cd /tmp && make` blocked), #5 (unattached = inert); plus: in-root write allowed; `~/`-under-root expansion; `../` escape blocked; bash command with no paths allowed.
- [ ] **Step 2-5: fail → implement → green → commit** — `t2b: path-scoped write guard (tool_call handler)`

---

### Task 5: Wiring + lifecycle + README

**Files:**
- Modify: `index.ts` (session lifecycle), `README.md`
- Test: `src/integration.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4.

Behavior pins:
- `session_shutdown` handler clears `WorkspaceState` (idempotent).
- `index.ts` factory registers all three tools + the guard handler; no side effects at load beyond registration.
- Integration test: against a mock registry, drive the full flow — resolve → attach → guard blocks an escape → detach via session_shutdown → guard inert. This is the Review-Focus-#5/#1 chain end-to-end at the extension level (tools invoked through their execute() functions, guard invoked as a handler — no pi process needed).
- README: what twill-pi is, install (copy/clone into `~/.pi/agent/extensions/twill-pi/`, config file shape, env override), the three tools with examples, the guard's contract (what it blocks, what it can't see — non-local routes, symlink escapes), the cold-workspace claim flow from the model's perspective.

- [ ] **Step 1: failing integration test.**
- [ ] **Step 2-5: fail → implement → green → commit** — `t2b: lifecycle wiring + integration test + README`

---

## Self-review notes (checked before saving)

- **Spec coverage:** workspace §6 e2e loop ✓ (T3); core §6.3 consumer-must-not-precondition ✓ (Global Constraints, T2's informational-only handling); core §9 claim shape ✓ (T3 via the T2a HTTP surface); workspace §3 RWO advisory ✓ (T2 warning); guard (the spec's structural-containment promise) ✓ (T4).
- **Type consistency:** `RegistryClient`/`Consumer`/`WorkspaceState` names pinned in T1/T2 Interfaces and consumed by name in T3/T4.
- **Proportion:** 5 tasks; the registry interaction is deliberately thin (the CLI already proved the contract), the weight sits in the claim loop and the guard.
- **Not in scope (deliberate):** provider-side materialization (the thing that actually clones + worktrees — that's a separate provider component, possibly in the twill repo, needed for the claim loop to ever observe `ready: true` against a real registry; the adapter's poll loop is tested against mocks); ssh route execution (advisory-only guard); k8s-exec (T3 milestone).
