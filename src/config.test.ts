// Config tests (Task 1) — defaults, file merge, TWILL_REGISTRY env
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
    });
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
