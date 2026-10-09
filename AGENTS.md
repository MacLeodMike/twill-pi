# AGENTS.md — working in the twill-pi repo

Operational guidance for a coding agent. twill-pi is the pi **substrate** for
the twill fabric. The design contracts it implements live in the twill repo
(`~/repos/twill/docs/superpowers/specs/`); the wider *why* is `~/repos/twill/CONTEXT.md`.

## What this is

The runtime-agnostic machinery every twill pi kind-package builds on:

- `src/config.ts` — loads `~/.pi/agent/twill-pi.json` (`TWILL_REGISTRY` env
  wins), fail-loud at load on malformed config.
- `src/registry-client.ts` — the HTTP client for the registry's v1alpha1 API.
- `src/resolve-types.ts` — the resolve wire types + `parseResolveResult`.
- `src/session-state.ts` — the `KindSessionState<T>` container **class** (never
  an instance — see below).
- `src/provider.ts` — `startEmbeddedProvider`, the seam that adapts config to
  the twill provider's `ProviderConfig` and runs it in-process.
- `index.ts` — the extension factory: registers only the `/twill` command, and
  (when a `provider` block is configured) the embedded provider's lifecycle
  handlers.

The workspace kind tools (twill_workspace_*) and the write guard live in the
sibling package `~/repos/twill-pi-workspace`.

## Commands

```bash
npm install          # deps + the file: dependency on ../twill
npm test             # vitest run — the gate
npx tsc --noEmit     # typecheck
```

## Conventions that carry weight

- **pi's lifecycle rule is load-bearing.** The factory starts NO processes,
  sockets, or timers — it registers handlers only. Long-lived resources (the
  embedded provider) start from `session_start` and stop from an idempotent
  `session_shutdown`. Some pi invocations load extensions without starting a
  session; a factory-side timer would leak into them.
- **No cross-package module singletons.** pi loads installed packages with
  separate module roots, so a module-level instance in twill-pi is a *different
  object* from the one a kind package's loaded copy sees. The substrate exports
  the `KindSessionState` **class**; each kind package constructs its OWN
  instance in its factory closure.
- **Structural typing for pi's API.** The factory's `ExtensionHost` and event
  shapes are typed structurally (not imported from the pi package), so the
  module typechecks and tests outside pi; pi's real `ExtensionAPI` satisfies
  the shape at load time.
- **The twill dependency is a `file:` path** to the local twill repo
  (dev shape; the registry's wire types come from `twill/provider`). Publish
  shape (a real semver package) is a later packaging milestone.

## The embedded provider

With a `provider` block in the config, twill-pi runs the twill provider
in-process (the homelab one-install story: registry client AND provider from
one install, no separate daemon). Provider lifecycle events log to
`~/.pi/agent/twill-provider.log` — NEVER stdout (that corrupts pi's TUI), and
per-poll skip/ignore noise is dropped. See the twill repo for the provider
loop itself.
