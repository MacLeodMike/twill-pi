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

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startProvider, type ProviderConfig, type ProviderHandle } from "@bitwise-operations/twill/provider";
import type { TwillPiConfig } from "./config.js";

/** Provider events go to a log file, never stdout — pi's TUI owns the
 *  terminal and a console.log per poll corrupts the input field and footer. */
const PROVIDER_LOG_PATH = join(homedir(), ".pi", "agent", "twill-provider.log");

/**
 * The lifecycle observer. Two jobs: (1) never write to stdout (TUI
 * corruption); (2) drop the per-poll steady-state noise ("skipped"/"ignored"
 * fire every poll for an un-released fulfilled claim) — only the meaningful
 * events (fulfilled / failed / provisioning) are worth a log line. Logging
 * must never throw into the loop.
 */
function logProviderEvent(line: string): void {
  if (/\bskipped\b|\bignored\b/.test(line)) return;
  try {
    appendFileSync(PROVIDER_LOG_PATH, line + "\n");
  } catch {
    // A logging failure must never reach the provider loop.
  }
}

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
  onEvent: (line: string) => void = logProviderEvent,
): ProviderHandle | null {
  const provider = config.provider;
  if (provider == null) return null;

  const providerConfig: ProviderConfig = {
    registry: config.registry,
    routes: provider.routes,
    parents: provider.parents,
    // Lifecycle events go to a log file (never stdout — that corrupts the
    // TUI); the per-poll skip/ignore noise is dropped. Injectable for tests.
    onEvent,
  };
  if (provider.pollIntervalMs !== undefined) {
    providerConfig.pollIntervalMs = provider.pollIntervalMs;
  }
  return start(providerConfig);
}
