// Factory tests (T2c) — the substrate extension registers ONLY the /twill
// command: no model-facing tools, no event handlers (the kind tools and the
// write guard moved to the kind packages). The /twill handler does a live
// GET /health against the configured registry and reports documentSet + the
// registry URL + the warnings count via ctx.ui.notify.
//
// Harness: the T2b capturing-host pattern (tools/commands/handlers captured
// by a structural ExtensionHost — no pi process) plus the
// registry-client.test.ts canned-HTTP boot for the health answer. The
// factory loads config from the default path, so TWILL_REGISTRY is stubbed
// to the mock's base URL (env wins over the file).

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import type { ProviderConfig, ProviderHandle } from "twill/provider";
import { startProvider } from "twill/provider";
import twillPi, {
  extensionState,
  setProviderStarterForTests,
  type CommandContextShape,
  type CommandRegistration,
  type ExtensionHost,
} from "../index.js";

const openServers: Server[] = [];

/** Boot a canned registry on an ephemeral port answering every request with `body`. */
async function boot(body: unknown): Promise<string> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  openServers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}/twill/v1alpha1`;
}

/** A base URL whose port is guaranteed closed (listened, then shut down). */
async function closedPortBase(): Promise<string> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((done) => server.close(() => done()));
  return `http://127.0.0.1:${port}/twill/v1alpha1`;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  // Reset the provider starter to the real path so a fake never leaks across
  // tests (the override is module-global).
  setProviderStarterForTests(startProvider);
  for (const server of openServers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

/** A capturing ExtensionHost: tools, commands, and event handlers by name. */
function makeHost(): {
  host: ExtensionHost;
  tools: Map<string, unknown>;
  commands: Map<string, CommandRegistration>;
  handlers: Map<string, Array<(event: never) => unknown>>;
} {
  const tools = new Map<string, unknown>();
  const commands = new Map<string, CommandRegistration>();
  const handlers = new Map<string, Array<(event: never) => unknown>>();
  const host: ExtensionHost = {
    registerTool(tool: unknown): void {
      tools.set((tool as { name: string }).name, tool);
    },
    registerCommand(name: string, options: CommandRegistration): void {
      commands.set(name, options);
    },
    on(event: string, handler: (event: never) => unknown): () => void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
  };
  return { host, tools, commands, handlers };
}

interface Notification {
  message: string;
  type: string;
}

/** A capturing command context (the structural minimum: ctx.ui.notify). */
function makeCtx(): { ctx: CommandContextShape; notes: Notification[] } {
  const notes: Notification[] = [];
  const ctx: CommandContextShape = {
    ui: {
      notify(message: string, type?: "info" | "warning" | "error"): void {
        notes.push({ message, type: type ?? "info" });
      },
    },
  };
  return { ctx, notes };
}

/** Run the factory against a fresh capturing host with TWILL_REGISTRY stubbed. */
function bootFactory(registry: string): ReturnType<typeof makeHost> {
  vi.stubEnv("TWILL_REGISTRY", registry);
  const captured = makeHost();
  twillPi(captured.host);
  return captured;
}

describe("substrate factory", () => {
  it("registers exactly one command (/twill), zero tools, and zero event handlers", () => {
    const { tools, commands, handlers } = bootFactory("http://127.0.0.1:1/twill/v1alpha1");
    expect(tools.size).toBe(0);
    expect(handlers.size).toBe(0);
    expect([...commands.keys()]).toEqual(["twill"]);
  });

  it("still loads config in the factory (TWILL_REGISTRY override lands in extensionState)", () => {
    const registry = "http://127.0.0.1:1/twill/v1alpha1";
    bootFactory(registry);
    expect(extensionState.config?.registry).toBe(registry);
  });

  it("/twill reports documentSet, the registry URL, and the warnings count", async () => {
    const base = await boot({ documentSet: "current", warnings: [] });
    const { commands } = bootFactory(base);
    const { ctx, notes } = makeCtx();

    await commands.get("twill")!.handler("", ctx);

    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe("info");
    expect(notes[0]!.message).toContain(base);
    expect(notes[0]!.message).toContain("documentSet=current");
    expect(notes[0]!.message).toContain("warnings=0");
  });

  it("/twill notifies a warning when the registry carries warnings", async () => {
    const base = await boot({
      documentSet: "current",
      warnings: [{ type: "overlay-corrupt-line", line: 2 }],
    });
    const { commands } = bootFactory(base);
    const { ctx, notes } = makeCtx();

    await commands.get("twill")!.handler("", ctx);

    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe("warning");
    expect(notes[0]!.message).toContain(base);
    expect(notes[0]!.message).toContain("warnings=1");
  });

  it("/twill notifies a warning on a stale documentSet, naming the reason", async () => {
    const base = await boot({
      documentSet: "stale",
      rejectedAt: "2026-10-07T01:00:00Z",
      reason: "fingerprint collision",
      warnings: [],
    });
    const { commands } = bootFactory(base);
    const { ctx, notes } = makeCtx();

    await commands.get("twill")!.handler("", ctx);

    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe("warning");
    expect(notes[0]!.message).toContain("documentSet=stale");
    expect(notes[0]!.message).toContain("warnings=0");
    expect(notes[0]!.message).toContain("fingerprint collision");
  });

  it("/twill notifies an error when the registry is unreachable", async () => {
    const base = await closedPortBase();
    const { commands } = bootFactory(base);
    const { ctx, notes } = makeCtx();

    await commands.get("twill")!.handler("", ctx);

    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe("error");
    expect(notes[0]!.message).toContain(base);
    expect(notes[0]!.message).toContain("unreachable");
  });
});

// Provider wiring (embed-provider Task 2): the factory starts the embedded
// provider iff a `provider` block is configured, and stops it on
// session_shutdown. A fake starter (setProviderStarterForTests) avoids a real
// poll loop; the provider block is file-only config, so these tests write a
// temp twill-pi.json and pass its path via the factory's second parameter
describe("embedded provider wiring", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Write a twill-pi.json carrying a provider block; return its path. */
  function configWithProvider(registry: string): string {
    const dir = mkdtempSync(join(tmpdir(), "twill-pi-factory-"));
    tmpDirs.push(dir);
    const path = join(dir, "twill-pi.json");
    writeFileSync(
      path,
      JSON.stringify({
        registry,
        provider: {
          parents: ["workstation-repos"],
          routes: [{ type: "local", match: { agentLocation: "workstation" }, path: "/srv/repos" }],
        },
      }),
    );
    return path;
  }

  /** A fake starter capturing the ProviderConfig and recording stop() calls. */
  function fakeStarter(): {
    start: (c: ProviderConfig) => ProviderHandle;
    calls: ProviderConfig[];
    stops: number;
  } {
    const state = { calls: [] as ProviderConfig[], stops: 0 };
    return {
      start(config: ProviderConfig): ProviderHandle {
        state.calls.push(config);
        return { stop: () => { state.stops += 1; } };
      },
      get calls() { return state.calls; },
      get stops() { return state.stops; },
    };
  }

  it("does NOT start the provider at load (pi lifecycle: no timers in the factory)", () => {
    const registry = "http://127.0.0.1:1/twill/v1alpha1";
    const configPath = configWithProvider(registry);
    const starter = fakeStarter();
    setProviderStarterForTests(starter.start);
    const captured = makeHost();
    twillPi(captured.host, { configPath });

    // The factory registers handlers but starts nothing: no poll loop at load.
    expect(starter.calls).toHaveLength(0);
    // Both lifecycle handlers are registered (provider is configured).
    expect(captured.handlers.get("session_start") ?? []).toHaveLength(1);
    expect(captured.handlers.get("session_shutdown") ?? []).toHaveLength(1);
  });

  it("starts the provider on session_start with the substrate's registry and stops it on session_shutdown", () => {
    const registry = "http://127.0.0.1:1/twill/v1alpha1";
    const configPath = configWithProvider(registry);
    const starter = fakeStarter();
    setProviderStarterForTests(starter.start);
    const captured = makeHost();
    twillPi(captured.host, { configPath });

    // Fire session_start: the provider starts with the substrate's registry.
    captured.handlers.get("session_start")![0]!(undefined as never);
    expect(starter.calls).toHaveLength(1);
    expect(starter.calls[0]!.registry).toBe(registry);
    expect(starter.calls[0]!.parents).toEqual(["workstation-repos"]);

    // A second session_start is a no-op (idempotent — no double-start).
    captured.handlers.get("session_start")![0]!(undefined as never);
    expect(starter.calls).toHaveLength(1);

    // session_shutdown stops the provider exactly once; a second is a no-op.
    const shutdowns = captured.handlers.get("session_shutdown") ?? [];
    shutdowns[0]!(undefined as never);
    expect(starter.stops).toBe(1);
    shutdowns[0]!(undefined as never);
    expect(starter.stops).toBe(1);
  });

  it("registers no lifecycle handlers when no provider block is configured (bare install)", () => {
    const registry = "http://127.0.0.1:1/twill/v1alpha1";
    const starter = fakeStarter();
    setProviderStarterForTests(starter.start);
    const captured = bootFactory(registry); // no provider block (default config path, no file)
    expect(starter.calls).toHaveLength(0);
    expect(captured.handlers.size).toBe(0); // no session_start/session_shutdown at all
  });
});
