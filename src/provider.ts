// twill-pi embedded provider (embed-provider Task 2) — the seam that adapts
// the substrate's config to the twill provider's ProviderConfig and runs the
// loop in-process. This is the homelab one-install story (provider spec §2):
// installing the pi extension yields a registry client AND a provider, no
// separate daemon. The provider loop itself lives in the twill repo
// (src/provider/loop.ts); this module only adapts config → start.
//
// The provider is config-GATED: it runs iff `twill-pi.json` carries a
// `provider` block (loadConfig validates that block fail-loud at load). No
// block → startEmbeddedProvider returns null and the factory starts nothing —
// bare installs are unchanged.
//
// The seam takes an injectable `start` (defaulting to the real startProvider)
// so the wiring is unit-testable without a real registry or poll loop.

import { startProvider, type ProviderConfig, type ProviderHandle } from "twill/provider";
import type { TwillPiConfig } from "./config.js";

/**
 * Adapt the substrate config to the provider's ProviderConfig and start the
 * loop. Returns the ProviderHandle, or null when no `provider` block is
 * configured (the caller — the factory — then starts nothing and registers no
 * shutdown hook).
 *
 * The block's presence is tested with `!= null`, NOT `"provider" in config`:
 * loadConfig materializes the key with value `undefined` when the block is
 * absent, so `in` would be a false positive.
 */
export function startEmbeddedProvider(
  config: TwillPiConfig,
  start: typeof startProvider = startProvider,
): ProviderHandle | null {
  const provider = config.provider;
  if (provider == null) return null;

  const providerConfig: ProviderConfig = {
    registry: config.registry,
    routes: provider.routes,
    parents: provider.parents,
    // pi captures extension stdout; notify-per-poll would be noise, so the
    // lifecycle observer logs.
    onEvent: (line) => console.log(line),
  };
  if (provider.pollIntervalMs !== undefined) {
    providerConfig.pollIntervalMs = provider.pollIntervalMs;
  }
  return start(providerConfig);
}
