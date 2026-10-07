// twill-pi — the twill fabric's pi SUBSTRATE package (T2c). This extension
// carries the shared machinery the kind packages build on (config, the
// registry client, the consumer tuple, resolve wire types, the generic
// per-kind session-state container) and registers a single status command,
// /twill — no model-facing tools, no tool_call guard. The workspace kind
// tools (twill_workspace_*) and the write guard live in the kind package
// twill-pi-workspace, which depends on this package's exports.
//
// pi loads this module at runtime via jiti (no build step); the default
// export is the extension factory pi calls with its ExtensionAPI. Per pi's
// lifecycle rules the factory starts no processes, sockets, or timers —
// config load is a synchronous file read; the /twill handler's registry
// fetch happens per command invocation, not at load.
//
// The factory's parameter is typed structurally (not imported from the pi
// package) so the module typechecks and tests outside pi; pi's real
// ExtensionAPI satisfies this shape at load time.

import { loadConfig, type TwillPiConfig } from "./src/config.js";
import { RegistryClient, type RegistryHealth } from "./src/registry-client.js";

/** The structural minimum of pi's ExtensionContext the /twill handler uses. */
export interface CommandContextShape {
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

/** The structural minimum of pi's command registration options. */
export interface CommandRegistration {
  description?: string;
  handler(args: string, ctx: CommandContextShape): Promise<void>;
}

/** The structural minimum of pi's ExtensionAPI this extension uses. */
export interface ExtensionHost {
  registerTool(tool: unknown): void;
  registerCommand(name: string, options: CommandRegistration): void;
  /** pi.on(event, handler) — returns the unsubscribe function. */
  on(event: string, handler: (event: never) => unknown): () => void;
}

/**
 * Module-local extension state: the loaded config, exposed for tests
 * asserting what the factory loaded. `config` is undefined until pi calls
 * the factory. (Not shared session state — kind packages hold their own.)
 */
export const extensionState: { config?: TwillPiConfig } = {};

/** The /twill command body: report health + endpoint through ctx.ui.notify. */
function reportHealth(ctx: CommandContextShape, registry: string, health: RegistryHealth): void {
  const parts = [
    `twill registry: ${registry}`,
    `documentSet=${health.documentSet}`,
    `warnings=${health.warnings.length}`,
  ];
  if (health.reason !== undefined) parts.push(`reason: ${health.reason}`);
  // A current set with no warnings is the healthy shape; anything else
  // (stale set, warnings) surfaces as a warning rather than an info.
  const type = health.documentSet === "current" && health.warnings.length === 0 ? "info" : "warning";
  ctx.ui.notify(parts.join(" — "), type);
}

export default function twillPi(pi: ExtensionHost): void {
  const config = loadConfig();
  extensionState.config = config;

  const client = new RegistryClient(config.registry);

  pi.registerCommand("twill", {
    description: "Show twill fabric status (registry endpoint + live health)",
    handler: async (_args, ctx) => {
      let health: RegistryHealth;
      try {
        health = await client.health();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`twill registry: ${config.registry} — unreachable (${message})`, "error");
        return;
      }
      reportHealth(ctx, config.registry, health);
    },
  });
}
