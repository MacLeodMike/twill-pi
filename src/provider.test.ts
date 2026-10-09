// startEmbeddedProvider tests (embed-provider Task 2) — the seam that adapts
// the substrate config to the provider's ProviderConfig and starts the loop.
// A FAKE `start` is injected (the DI seam) so no real registry or poll loop
// runs; the assertions are on the adapted ProviderConfig and the null case.

import { describe, it, expect } from "vitest";
import type { ProviderConfig, ProviderHandle } from "twill/provider";
import { startEmbeddedProvider } from "./provider.js";
import type { TwillPiConfig } from "./config.js";

/** A TwillPiConfig with a provider block (routes/parents verbatim). */
function configWithProvider(): TwillPiConfig {
  return {
    registry: "http://127.0.0.1:9999/twill/v1alpha1",
    agentLocation: "workstation",
    claimTimeoutMs: 600_000,
    pollIntervalMs: 7_000,
    writeGuard: true,
    provider: {
      parents: ["workstation-repos"],
      routes: [{ type: "local", match: { agentLocation: "workstation" }, path: "~/repos/workstation-repos" }],
      pollIntervalMs: 2000,
    },
  };
}

/** A TwillPiConfig with no provider block. */
function configWithoutProvider(): TwillPiConfig {
  return {
    registry: "http://127.0.0.1:9999/twill/v1alpha1",
    agentLocation: "workstation",
    claimTimeoutMs: 600_000,
    pollIntervalMs: 7_0e3,
    writeGuard: true,
  };
}

/** A fake starter capturing the ProviderConfig and returning a stub handle. */
function fakeStart(): { start: (c: ProviderConfig) => ProviderHandle; calls: ProviderConfig[] } {
  const calls: ProviderConfig[] = [];
  return {
    start(config: ProviderConfig): ProviderHandle {
      calls.push(config);
      return { stop: () => {} };
    },
    calls,
  };
}

describe("startEmbeddedProvider", () => {
  it("returns null and never calls start when no provider block is configured", () => {
    const { start, calls } = fakeStart();
    const handle = startEmbeddedProvider(configWithoutProvider(), start);
    expect(handle).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("adapts the config: registry from the substrate config, routes/parents verbatim, onEvent a function", () => {
    const { start, calls } = fakeStart();
    const config = configWithProvider();
    const handle = startEmbeddedProvider(config, start);
    expect(handle).not.toBeNull();
    expect(calls).toHaveLength(1);
    const passed = calls[0]!;
    expect(passed.registry).toBe(config.registry); // the substrate's registry, not a default
    expect(passed.routes).toBe(config.provider!.routes); // verbatim reference
    expect(passed.parents).toBe(config.provider!.parents); // verbatim reference
    expect(passed.pollIntervalMs).toBe(2000);
    expect(typeof passed.onEvent).toBe("function");
  });

  it("omits pollIntervalMs when the block doesn't carry it (the loop defaults itself)", () => {
    const { start, calls } = fakeStart();
    const config = configWithProvider();
    delete config.provider!.pollIntervalMs;
    startEmbeddedProvider(config, start);
    expect(calls[0]!.pollIntervalMs).toBeUndefined();
  });
});
