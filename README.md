# twill-pi

The twill fabric's pi **substrate** package — a pi extension that is also an importable library. It carries the shared machinery every pi kind adapter builds on (config, the registry HTTP client, the core §7.1 consumer tuple, the core §7/§8 resolve wire types, the generic per-kind session-state container) and registers exactly one user-facing surface: the `/twill` status command. It registers **no model-facing tools** and **no tool_call guard** — those belong to the kind packages.

**You want [twill-pi-workspace](../twill-pi-workspace) for actual workspaces** (the `twill_workspace_resolve` / `twill_workspace_attach` / `twill_workspace_claim` tools and the path-scoped write guard). twill-pi alone is the base layer those tools consume. Install both packages; pi loads each in its own module root.

It is a pure HTTP consumer of the registry's v1alpha1 API (the same contract the `twill` CLI exercises); it imports nothing from the twill repo. Design contracts (in the twill repo): the fabric core spec (`docs/superpowers/specs/2026-10-04-twill-fabric-core.md`) and the workspace spec (`docs/superpowers/specs/2026-10-04-twill-workspace.md`).

## Install

```sh
pi install <this repo or package>        # substrate
pi install <twill-pi-workspace repo>     # workspace kind adapter
```

For local development, pi loads extensions from `~/.pi/agent/extensions/`:

```sh
git clone <this repo> ~/.pi/agent/extensions/twill-pi
cd ~/.pi/agent/extensions/twill-pi && npm install
```

No build step — pi loads `index.ts` at runtime via jiti. Restart pi after installing. The package manifest declares `pi.extensions: ["./index.ts"]` and the `pi-package` keyword; `typebox` is host-provided per pi's package conventions and lives in `peerDependencies` (this package's own code imports nothing from it).

## The `/twill` command

`/twill` reports the fabric's status: the configured registry endpoint plus a **live** `GET <registry>/health` answer — documentSet (`current`/`stale`) and the warnings count. A healthy answer (`current`, zero warnings) notifies as info; a stale set or any warnings notify as a warning (with the reason); an unreachable registry notifies as an error. Nothing is cached between invocations.

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
- `agentLocation` — the consumer location matched against route `match` blocks (used in the consumer tuple below).
- `claimTimeoutMs` / `pollIntervalMs` — the claim loop's defaults, consumed by kind packages (twill-pi-workspace's claim tool).

Malformed JSON fails loud at extension load, not mid-command.

## Substrate exports

Kind packages import the substrate through this package's `exports` map (`dependencies: {"twill-pi": "…"}`):

| Subpath | Exports |
|---|---|
| `twill-pi` (root) | default export: the extension factory itself (what pi loads — registers only `/twill`); plus `extensionState` and the structural host types (`ExtensionHost`, `CommandRegistration`, `CommandContextShape`), for tests that load the factory through the package specifier |
| `twill-pi/config` | `loadConfig`, `consumerFromConfig`, `TwillPiConfig`, `LoadConfigOptions`, `DEFAULT_CONFIG`, `DEFAULT_CONFIG_PATH`, `REGISTRY_ENV_VAR` |
| `twill-pi/registry-client` | `RegistryClient`, `RegistryError`, `Consumer`, `RegistryHealth` |
| `twill-pi/resolve-types` | `parseResolveResult` + the core §7/§8 wire types (`ResolveResult`, `ResolveDescriptor`, `StatusSurface`, `ClaimedRef`) |
| `twill-pi/session-state` | `KindSessionState<T>` |

`consumerFromConfig` derives the core §7.1 consumer tuple (agentKind `"pi"`, principal `pi/<version>@<location>`, self-declared and untrusted per core §5).

### KindSessionState

```ts
class KindSessionState<T> {
  attach(v: T): void;      // set; replaces any previous attachment
  detach(): void;          // clear; idempotent
  current(): T | null;     // the current attachment, or null
}
```

The substrate provides the **class, never an instance**. Pi loads installed packages with separate module roots, so a shared module singleton is impossible by construction — each kind package instantiates its own container **in its factory closure** (e.g. `new KindSessionState<AttachedWorkspace>()`) and hands it to the tools/handlers it registers.

## Lifecycle

The substrate holds no session state: on pi `/reload` (or any session shutdown) the factory simply re-runs. Kind packages that keep attach state start unattached after a reload — re-derivation from transcript entries is a later enhancement (see twill-pi-workspace's README for its lifecycle section).

## Develop

```sh
npm install
npm test          # vitest, run outside pi against a canned registry
npx tsc --noEmit  # typecheck
```
