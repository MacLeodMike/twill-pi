// twill-pi — the pi extension that is the twill fabric's first
// consumer-adapter (T2b). pi loads this module at runtime via jiti (no
// build step); the default export is the extension factory pi calls with
// its ExtensionAPI.
//
// Task 1 scope: the factory loads config and stores it module-locally.
// Later tasks register the three tools (twill_resolve / twill_attach /
// twill_claim, Tasks 2–3) and the tool_call write guard (Task 4); their
// bodies close over this config and the RegistryClient built from it.
// Per pi's lifecycle rules the factory starts no processes, sockets, or
// timers — config load is a synchronous file read.
//
// The factory's parameter is typed structurally (not imported from the pi
// package) so the module typechecks and tests outside pi; pi's real
// ExtensionAPI satisfies this shape at load time.

import { loadConfig, type TwillPiConfig } from "./src/config.js";

/** The structural minimum of pi's ExtensionAPI this extension uses. */
export interface ExtensionHost {
  registerTool(tool: unknown): void;
}

/**
 * Module-local extension state: the loaded config, exposed for the tool
 * bodies later tasks register (and for tests asserting what the factory
 * loaded). `config` is undefined until pi calls the factory.
 */
export const extensionState: { config?: TwillPiConfig } = {};

export default function twillPi(pi: ExtensionHost): void {
  extensionState.config = loadConfig();
  // Task 2+ registers tools here via pi.registerTool(...). Task 1 registers
  // nothing — config load is the whole factory.
  void pi;
}
