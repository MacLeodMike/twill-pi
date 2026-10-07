// twill-pi — the pi extension that is the twill fabric's first
// consumer-adapter (T2b). pi loads this module at runtime via jiti (no
// build step); the default export is the extension factory pi calls with
// its ExtensionAPI.
//
// Task 2 scope: the factory loads config, builds the RegistryClient +
// consumer tuple + session WorkspaceState in its closure, and registers the
// twill_resolve / twill_attach tools. Later tasks add twill_claim (Task 3,
// closing over the same client/state) and the tool_call write guard
// (Task 4, reading the same state). Per pi's lifecycle rules the factory
// starts no processes, sockets, or timers — config load is a synchronous
// file read.
//
// The factory's parameter is typed structurally (not imported from the pi
// package) so the module typechecks and tests outside pi; pi's real
// ExtensionAPI satisfies this shape at load time.

import { consumerFromConfig, loadConfig, type TwillPiConfig } from "./src/config.js";
import { RegistryClient } from "./src/registry-client.js";
import { attachTool } from "./src/tools/attach.js";
import { resolveTool } from "./src/tools/resolve.js";
import { WorkspaceState } from "./src/workspace-state.js";

/** The structural minimum of pi's ExtensionAPI this extension uses. */
export interface ExtensionHost {
  registerTool(tool: unknown): void;
}

/**
 * Module-local extension state: the loaded config, exposed for tests
 * asserting what the factory loaded (tool bodies close over the factory
 * locals — client/consumer/state — not this bag). `config` is undefined
 * until pi calls the factory.
 */
export const extensionState: { config?: TwillPiConfig } = {};

export default function twillPi(pi: ExtensionHost): void {
  const config = loadConfig();
  extensionState.config = config;

  const client = new RegistryClient(config.registry);
  const consumer = consumerFromConfig(config);
  const state = new WorkspaceState();

  pi.registerTool(resolveTool(client, consumer));
  pi.registerTool(attachTool(client, consumer, state));
}
