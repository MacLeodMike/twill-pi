// Config tests (T2b) — defaults, file merge, TWILL_REGISTRY env
// override, malformed-file failure, and the consumer tuple.
//
// The config path and env are injected (loadConfig takes both) so tests
// never touch the real ~/.pi/agent/twill-pi.json or process.env.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, consumerFromConfig, DEFAULT_CONFIG } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string };

const tempDirs: string[] = [];

/** Fresh temp dir per test that needs one; removed in afterEach. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "twill-pi-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns the pinned defaults when the config file is missing", () => {
    const config = loadConfig({ configPath: join(tempDir(), "absent.json"), env: {} });
    expect(config).toEqual({
      registry: "http://localhost:8080/twill/v1alpha1",
      agentLocation: "workstation",
      claimTimeoutMs: 600_000,
      pollIntervalMs: 7_000,
      writeGuard: true,
    });
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("merges file values over the defaults; unspecified keys keep their defaults", () => {
    const dir = tempDir();
    const configPath = join(dir, "twill-pi.json");
    writeFileSync(configPath, JSON.stringify({ registry: "http://file:9000/twill/v1alpha1", pollIntervalMs: 500 }));
    const config = loadConfig({ configPath, env: {} });
    expect(config).toEqual({
      registry: "http://file:9000/twill/v1alpha1",
      agentLocation: "workstation",
      claimTimeoutMs: 600_000,
      pollIntervalMs: 500,
      writeGuard: true,
    });
  });

  it("writeGuard: defaults true, honors an explicit false, ignores a non-boolean", () => {
    const dir = tempDir();
    const configPath = join(dir, "twill-pi.json");
    // absent → default true
    writeFileSync(configPath, JSON.stringify({}));
    expect(loadConfig({ configPath, env: {} }).writeGuard).toBe(true);
    // explicit false → false
    writeFileSync(configPath, JSON.stringify({ writeGuard: false }));
    expect(loadConfig({ configPath, env: {} }).writeGuard).toBe(false);
    // a non-boolean value keeps the default (the field() typeof check)
    writeFileSync(configPath, JSON.stringify({ writeGuard: "no" }));
    expect(loadConfig({ configPath, env: {} }).writeGuard).toBe(true);
  });

  it("TWILL_REGISTRY env wins over both the file and the default", () => {
    const dir = tempDir();
    const configPath = join(dir, "twill-pi.json");
    writeFileSync(configPath, JSON.stringify({ registry: "http://file:9000/twill/v1alpha1" }));
    const config = loadConfig({ configPath, env: { TWILL_REGISTRY: "http://env:9001/twill/v1alpha1" } });
    expect(config.registry).toBe("http://env:9001/twill/v1alpha1");
  });

  it("malformed JSON throws, naming the file path (fail loud at extension load)", () => {
    const dir = tempDir();
    const configPath = join(dir, "twill-pi.json");
    writeFileSync(configPath, "{not json");
    expect(() => loadConfig({ configPath, env: {} })).toThrow(configPath);
  });

  it("a non-object JSON document throws, naming the file path", () => {
    const dir = tempDir();
    const configPath = join(dir, "twill-pi.json");
    writeFileSync(configPath, JSON.stringify([1, 2, 3]));
    expect(() => loadConfig({ configPath, env: {} })).toThrow(configPath);
  });
});

// Provider-block tests (embed-provider Task 1) — the optional embedded-provider
// config. The block is fail-loud at load (never a half-started provider, plan
// Review Focus #4) and route objects pass through VERBATIM: the provider's
// exact-match binding needs them byte-identical to the route a claim carries,
// so loadConfig must not normalize, strip, or rewrite anything inside them.

describe("loadConfig: provider block", () => {
  it("absent provider block → config.provider is undefined (bare installs unchanged)", () => {
    const dir = tempDir();
    const configPath = join(dir, "twill-pi.json");
    writeFileSync(configPath, JSON.stringify({ registry: "http://file:9000/twill/v1alpha1" }));
    const config = loadConfig({ configPath, env: {} });
    expect(config.provider).toBeUndefined();
    expect(config.registry).toBe("http://file:9000/twill/v1alpha1");
  });

  it("valid provider block parses through; route objects verbatim (unknown keys preserved)", () => {
    const dir = tempDir();
    const configPath = join(dir, "twill-pi.json");
    const route = {
      type: "local",
      path: "/home/u/repos/ws-main",
      match: { agentKind: "pi" },
      futureKey: { nested: [1, 2] },
    };
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: { parents: ["ws-main", "ws-second"], routes: [route], pollIntervalMs: 250 },
      }),
    );
    const config = loadConfig({ configPath, env: {} });
    expect(config.provider).toEqual({
      parents: ["ws-main", "ws-second"],
      routes: [route],
      pollIntervalMs: 250,
    });
  });

  it("provider block without pollIntervalMs omits the key; the block survives TWILL_REGISTRY", () => {
    const dir = tempDir();
    const configPath = join(dir, "twill-pi.json");
    writeFileSync(
      configPath,
      JSON.stringify({ provider: { parents: ["ws-main"], routes: [{ type: "local", path: "/x" }] } }),
    );
    const config = loadConfig({ configPath, env: { TWILL_REGISTRY: "http://env:9001/twill/v1alpha1" } });
    expect(config.registry).toBe("http://env:9001/twill/v1alpha1");
    expect(config.provider).toEqual({
      parents: ["ws-main"],
      routes: [{ type: "local", path: "/x" }],
    });
    expect("pollIntervalMs" in (config.provider ?? {})).toBe(false);
  });

  /** Write the JSON contents and assert loadConfig throws naming the file path AND the field. */
  function expectFieldError(configPath: string, contents: unknown, field: string): void {
    writeFileSync(configPath, JSON.stringify(contents));
    expect(() => loadConfig({ configPath, env: {} })).toThrow(field);
    expect(() => loadConfig({ configPath, env: {} })).toThrow(configPath);
  }

  it("provider present but not an object throws naming the field", () => {
    const dir = tempDir();
    const configPath = join(dir, "twill-pi.json");
    expectFieldError(configPath, { provider: "nope" }, "provider: expected an object");
    expectFieldError(configPath, { provider: ["not", "an", "object"] }, "provider: expected an object");
  });

  it("parents must be a non-empty array of strings", () => {
    const dir = tempDir();
    const configPath = join(dir, "twill-pi.json");
    expectFieldError(configPath, { provider: {} }, "provider.parents");
    expectFieldError(configPath, { provider: { parents: [] } }, "provider.parents");
    expectFieldError(configPath, { provider: { parents: "ws-main" } }, "provider.parents");
    expectFieldError(configPath, { provider: { parents: ["ws-main", 42] } }, "provider.parents");
  });

  it("routes must be a non-empty array", () => {
    const dir = tempDir();
    const configPath = join(dir, "twill-pi.json");
    expectFieldError(
      configPath,
      { provider: { parents: ["ws-main"] } },
      "provider.routes",
    );
    expectFieldError(
      configPath,
      { provider: { parents: ["ws-main"], routes: [] } },
      "provider.routes",
    );
  });

  it("a route that is not an object, or without a string type, throws naming its index", () => {
    const dir = tempDir();
    const configPath = join(dir, "twill-pi.json");
    expectFieldError(
      configPath,
      { provider: { parents: ["ws-main"], routes: [{ path: "/x" }] } },
      "provider.routes[0]",
    );
    expectFieldError(
      configPath,
      { provider: { parents: ["ws-main"], routes: [{ type: 7 }] } },
      "provider.routes[0]",
    );
    expectFieldError(
      configPath,
      { provider: { parents: ["ws-main"], routes: ["not-an-object"] } },
      "provider.routes[0]",
    );
  });

  it("pollIntervalMs present but not a positive number throws", () => {
    const dir = tempDir();
    const configPath = join(dir, "twill-pi.json");
    const valid = { parents: ["ws-main"], routes: [{ type: "local", path: "/x" }] };
    expectFieldError(configPath, { provider: { ...valid, pollIntervalMs: 0 } }, "provider.pollIntervalMs");
    expectFieldError(configPath, { provider: { ...valid, pollIntervalMs: -5 } }, "provider.pollIntervalMs");
    expectFieldError(configPath, { provider: { ...valid, pollIntervalMs: "fast" } }, "provider.pollIntervalMs");
  });
});

describe("consumerFromConfig", () => {
  it("declares agentKind pi and principal pi/<version>@<location> (version from package.json)", () => {
    const consumer = consumerFromConfig(DEFAULT_CONFIG);
    expect(consumer).toEqual({
      agentLocation: "workstation",
      agentKind: "pi",
      principal: `pi/${pkg.version}@workstation`,
    });
  });

  it("takes agentLocation from the config (and into the principal)", () => {
    const consumer = consumerFromConfig({ ...DEFAULT_CONFIG, agentLocation: "talos4" });
    expect(consumer.agentLocation).toBe("talos4");
    expect(consumer.principal).toBe(`pi/${pkg.version}@talos4`);
  });
});
