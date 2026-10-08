// twill-pi configuration (T2b) — ~/.pi/agent/twill-pi.json with the
// TWILL_REGISTRY env override (env wins), merged over pinned defaults.
//
// The file is optional: missing → defaults, no error. Malformed JSON (or a
// non-object document) throws with the file path — the extension factory
// loads config at load time, so a broken config fails loud there instead
// of surfacing mid-tool-call.
//
// The optional `provider` block (embed-provider Task 1) configures the
// embedded twill provider. It is validated the same way — fail loud at
// load, never a half-started provider — and its route objects pass through
// VERBATIM: the provider's exact-match binding deep-equals a claim's route
// against them, so no normalization, stripping, or rewriting here.
//
// consumerFromConfig derives the core §7.1 consumer tuple: agentKind "pi",
// principal "pi/<version>@<location>" with the version read from this
// package's own package.json (self-declared, untrusted per core §5).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Route } from "twill/provider";
import type { Consumer } from "./registry-client.js";

export interface TwillPiConfig {
  /** Registry base URL (the /twill/v1alpha1 root). */
  registry: string;
  /** The core §7.1 consumer agentLocation (matched against route.match). */
  agentLocation: string;
  /** Default claim timeout (the kind packages' claim-and-poll loop). */
  claimTimeoutMs: number;
  /** Poll interval for the claim-and-poll loop. */
  pollIntervalMs: number;
  /** The embedded provider config; absent → no provider (bare installs). */
  provider?: TwillPiProviderConfig;
}

/** The optional embedded-provider block (embed-provider Task 1). Present →
 *  the factory starts the twill provider loop against the shared registry. */
export interface TwillPiProviderConfig {
  /** Parent workspace names the provider polls for claims. */
  parents: string[];
  /** The verbatim route objects this provider owns — a claim is this
   *  provider's iff its route deep-equals one of these, so they must stay
   *  byte-identical to what the parent Workspace document carries. */
  routes: Route[];
  /** Provider poll interval override (the loop defaults itself otherwise). */
  pollIntervalMs?: number;
}

/** The pinned defaults (plan's Global Constraints). */
export const DEFAULT_CONFIG: TwillPiConfig = {
  registry: "http://localhost:8080/twill/v1alpha1",
  agentLocation: "workstation",
  claimTimeoutMs: 600_000,
  pollIntervalMs: 7_000,
};

/** Where pi keeps per-extension config; loadConfig's default path. */
export const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "agent", "twill-pi.json");

/** The env var that overrides the registry base URL (wins over the file). */
export const REGISTRY_ENV_VAR = "TWILL_REGISTRY";

export interface LoadConfigOptions {
  /** Config file path; defaults to ~/.pi/agent/twill-pi.json. */
  configPath?: string;
  /** Environment source; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One string-or-number config field from the file, with the default kept otherwise. */
function field<T extends string | number>(
  file: Record<string, unknown>,
  key: string,
  fallback: T,
): T {
  const value = file[key];
  return typeof value === typeof fallback ? (value as T) : fallback;
}

/** Load config: defaults ← file values ← TWILL_REGISTRY. Missing file is not an error. */
export function loadConfig(options: LoadConfigOptions = {}): TwillPiConfig {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const env = options.env ?? process.env;

  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    // A missing file means "no overrides" — every other read failure is
    // loud and names the path.
    if (isRecord(err) && err["code"] === "ENOENT") return withEnvOverride(DEFAULT_CONFIG, env);
    throw new Error(`${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${configPath}: malformed JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `${configPath}: expected a JSON object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}`,
    );
  }

  const config: TwillPiConfig = {
    registry: field(parsed, "registry", DEFAULT_CONFIG.registry),
    agentLocation: field(parsed, "agentLocation", DEFAULT_CONFIG.agentLocation),
    claimTimeoutMs: field(parsed, "claimTimeoutMs", DEFAULT_CONFIG.claimTimeoutMs),
    pollIntervalMs: field(parsed, "pollIntervalMs", DEFAULT_CONFIG.pollIntervalMs),
    provider: parseProviderBlock(parsed, configPath),
  };
  return withEnvOverride(config, env);
}

/** Parse + validate the optional `provider` block (fail loud at load:
 *  the factory must never start a half-validated provider). Absent block →
 *  undefined. Route objects pass through verbatim — the provider's
 *  exact-match binding needs them byte-identical to the route a claim
 *  carries, so only shape is checked, contents are never touched. */
function parseProviderBlock(
  file: Record<string, unknown>,
  configPath: string,
): TwillPiProviderConfig | undefined {
  if (!("provider" in file)) return undefined;
  const block = file["provider"];
  if (!isRecord(block)) {
    throw new Error(
      `${configPath}: provider: expected an object, got ${Array.isArray(block) ? "an array" : typeof block}`,
    );
  }

  const parents = block["parents"];
  if (
    !Array.isArray(parents) ||
    parents.length === 0 ||
    parents.some((parent) => typeof parent !== "string")
  ) {
    throw new Error(`${configPath}: provider.parents: expected a non-empty array of strings`);
  }

  const routes = block["routes"];
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error(`${configPath}: provider.routes: expected a non-empty array of route objects`);
  }
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    if (!isRecord(route) || typeof route["type"] !== "string") {
      throw new Error(`${configPath}: provider.routes[${i}]: expected an object with a string "type"`);
    }
  }

  const pollIntervalMs = block["pollIntervalMs"];
  if (pollIntervalMs !== undefined && !(typeof pollIntervalMs === "number" && pollIntervalMs > 0)) {
    throw new Error(`${configPath}: provider.pollIntervalMs: expected a positive number`);
  }

  return {
    parents,
    routes,
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
  };
}

/** The TWILL_REGISTRY override step (applied last — env wins). */
function withEnvOverride(config: TwillPiConfig, env: NodeJS.ProcessEnv): TwillPiConfig {
  const override = env[REGISTRY_ENV_VAR];
  if (typeof override === "string" && override !== "") {
    return { ...config, registry: override };
  }
  return { ...config };
}

/** This package's own version (for the principal string). */
function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version === "") {
    throw new Error("twill-pi: package.json carries no version string");
  }
  return pkg.version;
}

/**
 * The core §7.1 consumer tuple this adapter declares: agentKind "pi",
 * agentLocation from config, principal "pi/<version>@<location>"
 * (self-declared, untrusted per core §5).
 */
export function consumerFromConfig(config: TwillPiConfig): Consumer {
  return {
    agentLocation: config.agentLocation,
    agentKind: "pi",
    principal: `pi/${packageVersion()}@${config.agentLocation}`,
  };
}
