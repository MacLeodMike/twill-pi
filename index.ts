// twill-pi — the pi extension that is the twill fabric's first
// consumer-adapter (T2b). pi loads this module at runtime via jiti (no
// build step); the default export is the extension factory pi calls with
// its ExtensionAPI.
//
// Task 3 scope: the factory loads config, builds the RegistryClient +
// consumer tuple + session WorkspaceState in its closure, and registers the
// twill_resolve / twill_attach / twill_claim tools (twill_claim closes over
// the same client/consumer/state and reads claimTimeoutMs/pollIntervalMs
// from the loaded config). Task 4 registers the tool_call write guard
// reading the same state: unattached → inert; local routes → confined;
// non-local routes → advisory-only. Per pi's lifecycle rules the factory
// starts no processes, sockets, or timers — config load is a synchronous
// file read.
//
// The factory's parameter is typed structurally (not imported from the pi
// package) so the module typechecks and tests outside pi; pi's real
// ExtensionAPI satisfies this shape at load time.

import { consumerFromConfig, loadConfig, type TwillPiConfig } from "./src/config.js";
import { guardToolCall, type ToolCallEventShape } from "./src/guard.js";
import { RegistryClient } from "./src/registry-client.js";
import { attachTool } from "./src/tools/attach.js";
import { claimTool } from "./src/tools/claim.js";
import { resolveTool } from "./src/tools/resolve.js";
import { WorkspaceState } from "./src/workspace-state.js";

/** The structural minimum of pi's ExtensionAPI this extension uses. */
export interface ExtensionHost {
  registerTool(tool: unknown): void;
  /** pi.on(event, handler) — returns the unsubscribe function. */
  on(event: "tool_call", handler: (event: ToolCallEventShape) => unknown): () => void;
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
  pi.registerTool(
    claimTool(client, consumer, state, {
      claimTimeoutMs: config.claimTimeoutMs,
      pollIntervalMs: config.pollIntervalMs,
    }),
  );

  // Task 4: the path-scoped write guard. Inert until a workspace is
  // attached; the handler is a pure read of the session state.
  pi.on("tool_call", (event) => guardToolCall(event, state));
}
