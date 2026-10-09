# twill-pi

The twill fabric's pi **substrate** package — a pi extension that is also an importable library. It carries the shared machinery every pi kind adapter builds on (config, the registry HTTP client, the core §7.1 consumer tuple, the core §7/§8 resolve wire types, the generic per-kind session-state container) and registers exactly one user-facing surface: the `/twill` status command. It registers **no model-facing tools** and **no tool_call guard** — those belong to the kind packages.

**You want [twill-pi-workspace](../twill-pi-workspace) for actual workspaces** (the `twill_workspace_resolve` / `twill_workspace_attach` / `twill_workspace_claim` tools and the path-scoped write guard). twill-pi alone is the base layer those tools consume. Install both packages; pi loads each in its own module root.

It is a pure HTTP consumer of the registry's v1alpha1 API (the same contract the `twill` CLI exercises) — with one config-gated exception: the [embedded provider](#embedded-provider) imports the provider loop from the twill repo (`twill/provider`) and runs it in-process. Design contracts (in the twill repo): the fabric core spec (`docs/superpowers/specs/2026-10-04-twill-fabric-core.md`), the workspace spec (`docs/superpowers/specs/2026-10-04-twill-workspace.md`), and the localhost provider spec (`docs/superpowers/specs/2026-10-07-twill-localhost-provider.md`).

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
  "pollIntervalMs": 7000,
  "writeGuard": true
}
```

- `registry` — the registry's v1alpha1 root. The `TWILL_REGISTRY` environment variable overrides it (env wins).
- `agentLocation` — the consumer location matched against route `match` blocks (used in the consumer tuple below).
- `claimTimeoutMs` / `pollIntervalMs` — the claim loop's defaults, consumed by kind packages (twill-pi-workspace's claim tool).
- `writeGuard` — parsed here, consumed by kind packages: twill-pi-workspace's write guard confines its write/edit tools to the attached workspace root when this is `true` (the default). The substrate only parses + exposes it. Set `false` to disable the guard.
- `provider` — the optional embedded-provider block; see [Embedded provider](#embedded-provider).

Malformed JSON fails loud at extension load, not mid-command.

## Embedded provider

The substrate can run the fabric's **provider** in-process: with a `provider` block in the config, one install of twill-pi is a registry client *and* a provider against the same registry — no separate `twill provider` daemon to run. That is the homelab one-install story: install twill-pi (+ the kind packages), configure the block, and claims against your workspaces materialize on this machine while the same extension serves the tools that claim them. The provider loop itself lives in the [twill repo](../twill) (`src/provider/loop.ts`), consumed through the `twill` dependency's `twill/provider` export.

A complete config with the block:

```json
{
  "registry": "http://localhost:8080/twill/v1alpha1",
  "agentLocation": "workstation",
  "provider": {
    "parents": ["workstation-repos"],
    "routes": [
      {
        "match": { "agentLocation": "workstation" },
        "type": "local",
        "path": "/home/you/repos/workstation-repos",
        "precondition": {
          "steps": [
            { "type": "gitClone", "url": "https://git.example/you/workstation-repos.git", "ref": "main" }
          ]
        }
      }
    ],
    "pollIntervalMs": 5000
  }
}
```

- `provider.parents` — the parent Workspace names this provider polls for claims (required: a non-empty array of strings).
- `provider.routes` — the **verbatim** route objects this provider owns (required: a non-empty array of route objects, each with a string `type`). A claim is this provider's iff its `spec.claim.route` deep-equals one of these, so each route must stay byte-identical to the route the parent Workspace document carries. Only the shape is validated; contents pass through untouched.
- `provider.pollIntervalMs` — optional poll-interval override (a positive number; the loop defaults to 5000 ms).

Rules:

- **Explicit config.** No `provider` block → no provider, no timer — a bare install is exactly the substrate-only shape. A malformed block (missing or empty `parents`/`routes`, a route without a string `type`, a non-positive `pollIntervalMs`) fails loud at extension load, never a half-started provider.
- **The registry is shared.** The provider polls the registry named by the top-level `registry` field — the same endpoint the registry client uses, including the `TWILL_REGISTRY` override.
- **Lifecycle.** Per pi's rule (no timers in the factory), the factory only registers handlers: the loop starts on `session_start` when the block is configured and stops on `session_shutdown` (both idempotent). Lifecycle events (claim fulfilled / failed / ignored / skipped) are logged to stdout — pi captures extension stdout.
- **v1 scope.** The provider materializes `gitClone` and `worktree` preconditions on local (`type: "local"`) routes only; `pvcBind`, `remoteMkdir`, and `mountCheck` fail loud as unsupported, and a non-local route is never materialized at its remote path.

The in-process loop is proven end-to-end by `src/provider.integration.test.ts`: a real in-process registry + the embedded provider + a claim over HTTP → the child Workspace materializes on disk and resolves with `ready: true`.

## Substrate exports

Kind packages import the substrate through this package's `exports` map (`dependencies: {"twill-pi": "…"}`):

| Subpath | Exports |
|---|---|
| `twill-pi` (root) | default export: the extension factory itself (what pi loads — registers only `/twill`); plus `extensionState`, `setProviderStarterForTests` (the provider test seam), and the structural host types (`ExtensionHost`, `CommandRegistration`, `CommandContextShape`), for tests that load the factory through the package specifier |
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

The substrate holds no session state: on pi `/reload` (or any session shutdown) the factory simply re-runs. The embedded provider (when configured) is the one exception — the factory registers lifecycle handlers so the loop starts on `session_start` and stops on `session_shutdown` (see [Embedded provider](#embedded-provider)). Kind packages that keep attach state start unattached after a reload — re-derivation from transcript entries is a later enhancement (see twill-pi-workspace's README for its lifecycle section).

## Develop

```sh
npm install
npm test          # vitest, run outside pi against a canned registry
npx tsc --noEmit  # typecheck
```
