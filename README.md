# twill-pi

The pi adapter for the twill workspace fabric — a pi extension that resolves workspaces through a twill registry, attaches them as the session's active workspace, confines writes to the workspace root with a path-scoped guard, and claims cold workspaces through the claim-and-poll loop. It is a pure HTTP consumer of the registry's v1alpha1 API (the same contract the `twill` CLI exercises); it imports nothing from the twill repo.

Design contracts (in the twill repo): [the fabric core spec](https://github.com/example/twill/blob/main/docs/superpowers/specs/2026-10-04-twill-fabric-core.md) (resolve protocol, consumer tuple, claims) and [the workspace spec](https://github.com/example/twill/blob/main/docs/superpowers/specs/2026-10-04-twill-workspace.md) (cold/ready lifecycle, RWO advisory, claim flow).

## Install

pi loads extensions from `~/.pi/agent/extensions/`:

```sh
git clone <this repo> ~/.pi/agent/extensions/twill-pi
cd ~/.pi/agent/extensions/twill-pi && npm install
```

No build step — pi loads `index.ts` at runtime via jiti. Alternatively, point pi at the directory with `pi --extension ~/.pi/agent/extensions/twill-pi`. Restart pi after installing.

## Config

`~/.pi/agent/twill-pi.json` (optional; a missing file means defaults — no error):

```json
{
  "registry": "http://localhost:8080/twill/v1alpha1",
  "agentLocation": "workstation",
  "claimTimeoutMs": 600000,
  "pollIntervalMs": 7000
}
```

- `registry` — the registry's v1alpha1 root. The `TWILL_REGISTRY` environment variable overrides it (env wins).
- `agentLocation` — the consumer location matched against route `match` blocks.
- `claimTimeoutMs` / `pollIntervalMs` — the claim loop's default timeout and poll cadence.

Malformed JSON fails loud at extension load, not mid-tool-call.

## The tools

### `twill_resolve` — look before you attach

```json
{ "kind": "Workspace", "name": "payments-repo" }
```

Returns the registry's `ResolveResult` verbatim as JSON. Three shapes:

- **`Attached`** — a route was selected. Read `descriptor.route` (e.g. `{"type": "local", "path": "~/repos/payments-repo"}`) and `descriptor.status`. **`status.ready: true`** means `twill_attach` can attach it now. **`ready: false` means the workspace is COLD — it is not attachable.** The tool prepends a `NOTE:` directing you to `twill_claim`.
- **`NoMatch`** — no object by that name, or no route matches this consumer.
- **`Unreachable`** — matching routes exist but none is selectable right now; per-route errors are listed.

### `twill_attach` — make a workspace the session's active workspace

```json
{ "kind": "Workspace", "name": "payments-repo" }
```

Resolves fresh every call. On a ready workspace it binds the route as the session state and answers with the expanded root, e.g. `root: /home/you/repos/payments-repo`. From then on use root-relative paths; **pi's cwd does not change**. Cold workspaces are refused (call `twill_claim` first). Attaching a second workspace replaces the first — the result notes the swap. If other consumers hold claims on the workspace, the attach still succeeds but carries a `WARNING:` naming them (the workspace spec's RWO advisory — coordinate before editing).

### `twill_claim` — wake a cold workspace

```json
{ "name": "payments-repo", "branch": "feat-x", "worktreeName": "feat-x" }
```

The cold-workspace flow (workspace spec §6), all inside the tool: resolve the parent, POST a Claim bound to the resolved route, then **poll** the materialized workspace until `status.ready: true` — then attach it automatically and answer like `twill_attach`. With `worktreeName` the materialized child is `<name>-<worktreeName>`; without it the parent itself is materialized.

On timeout or abort **the claim is left in place** (visible to operators; the provider may still finish) — the result names the claim and the release command, e.g.:

```
To release it explicitly: twill claim release Workspace payments-repo claim-payments-repo-pi-…-1759723200
```

Refuses when the workspace is already ready (use `twill_attach`) or not provisionable.

## The write guard

Once a workspace is attached, a `tool_call` handler confines writes to the workspace root.

**What it blocks** (only when the attached route is `local`):

- `write` / `edit` whose `path` escapes the root — including the classic sibling-repo mistake (`~/repos/other-repo/…` while attached to `~/repos/payments-repo`) and `../` escapes.
- `bash` commands whose command line contains absolute (`/…`) or home-rooted (`~/…`) path tokens that escape the root — e.g. `make install > /tmp/log` or `rm /etc/…`.

Block reasons name the tool, the root, and the offending resolved path. In-root paths pass; `~` is expanded and `.`/`..` folded before containment is judged.

**What it cannot see — this is NOT a sandbox.** The guard is a conservative-allow pre-flight check, not a security boundary. Known gaps, by design:

- **Non-local routes** (`ssh`, `k8s-exec`) are advisory-only: a local-process guard cannot see a remote filesystem, so everything is allowed (the attach summary still tells the model the root).
- **Bash parsing is naive**: tokens are whitespace-split with edge quotes stripped. Glued redirects (`>/tmp/x`), quoted paths containing spaces (only the first fragment is checked), command substitutions and subshells (`$(…)`), and relative paths after `cd` are missed.
- **Symlink escapes** are out of scope for v1.
- Only `write` / `edit` / `bash` are guarded; read-only and custom tools pass.

Inert when no workspace is attached — an unattached session is never blocked.

## Session lifecycle

Attaching is session state, nothing more: no daemon, no subprocess, no working-directory change. When the session shuts down (quit, or replacement via new/resume/fork), the extension detaches — the next session starts **unattached** and must `twill_attach` (or `twill_claim`) again. A fresh session never silently inherits a workspace.

## Develop

```sh
npm install
npm test          # vitest, run outside pi against a canned registry
npx tsc --noEmit  # typecheck
```
