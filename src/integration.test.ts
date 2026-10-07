// Integration test (Task 5) — the Review-Focus-#5/#1 chain end-to-end at
// the extension level: resolve → attach → guard blocks a sibling-repo
// write (tool_call event) → session_shutdown detaches → guard inert.
// Tools are invoked through their execute() functions and the guard as a
// registered handler against a captured ExtensionHost — no pi process.
//
// The registry is a real node:http server on an ephemeral port with a
// canned resolve answer (the registry-client.test.ts harness pattern).
// The factory loads config from the default path, so TWILL_REGISTRY is
// stubbed to the mock's base URL (env wins over the file).

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import twillPi, { extensionState, type ExtensionHost } from "../index.js";
import type { ToolCallEventShape, GuardVerdict } from "./guard.js";
import type { TwillTool } from "./tools/resolve.js";

const READY_ATTACHED = {
  result: "Attached",
  descriptor: {
    kind: "Workspace",
    name: "payments-repo",
    durable_id: "ws_01J8Z4-payments-repo",
    route: { match: { agentLocation: "workstation" }, type: "local", path: "~/repos/payments-repo" },
    status: {
      ready: true,
      provisionable: false,
      claimedBy: [],
      progress: "mounted",
      asOf: "2026-10-06T12:00:00Z",
      source: "live",
    },
  },
};

const openServers: Server[] = [];

/** Boot the canned registry: every POST /resolve answers READY_ATTACHED. */
async function boot(): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const answer = req.method === "POST" && (req.url ?? "").endsWith("/resolve")
        ? { status: 200, body: READY_ATTACHED }
        : { status: 404, body: { error: `unexpected ${req.method} ${req.url}` } };
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  openServers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}/twill/v1alpha1`;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of openServers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

/**
 * A capturing ExtensionHost: tools by name, event handlers by event name.
 * The broad `on` signature satisfies both of ExtensionHost's overloads
 * (method bivariance); pi's real ExtensionAPI is the load-time contract.
 */
function makeHost(): {
  host: ExtensionHost;
  tools: Map<string, TwillTool>;
  handlers: Map<string, Array<(event: never) => unknown>>;
} {
  const tools = new Map<string, TwillTool>();
  const handlers = new Map<string, Array<(event: never) => unknown>>();
  const host = {
    registerTool(tool: unknown): void {
      const t = tool as TwillTool;
      tools.set(t.name, t);
    },
    on(event: string, handler: (event: never) => unknown): () => void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
  } as ExtensionHost;
  return { host, tools, handlers };
}

/** Fire every handler registered for `event`, returning their verdicts. */
function fire(
  handlers: Map<string, Array<(event: never) => unknown>>,
  event: string,
  payload: unknown,
): unknown[] {
  return (handlers.get(event) ?? []).map((h) => h(payload as never));
}

describe("integration: resolve → attach → guard → session_shutdown → inert", () => {
  it("drives the full chain through the factory's registered tools and handlers", async () => {
    const base = await boot();
    vi.stubEnv("TWILL_REGISTRY", base);

    const { host, tools, handlers } = makeHost();
    twillPi(host);

    // The factory registered all three tools + the guard + lifecycle handlers,
    // and loaded config with the env override.
    expect([...tools.keys()].sort()).toEqual(["twill_attach", "twill_claim", "twill_resolve"]);
    expect(handlers.get("tool_call")).toHaveLength(1);
    expect(handlers.get("session_shutdown")).toHaveLength(1);
    expect(extensionState.config?.registry).toBe(base);

    const root = join(homedir(), "repos", "payments-repo");
    const escapePath = join(homedir(), "repos", "other-repo", "x.ts");
    const writeEscape: ToolCallEventShape = {
      type: "tool_call",
      toolCallId: "w1",
      toolName: "write",
      input: { path: escapePath, content: "x" },
    };

    // Fresh session = unattached: the guard is inert before any attach (RF#5).
    expect(fire(handlers, "tool_call", writeEscape)).toEqual([undefined]);

    // resolve → Attached + ready (no COLD note).
    const resolveResult = await tools
      .get("twill_resolve")!
      .execute("t1", { kind: "Workspace", name: "payments-repo" }, undefined, undefined, undefined);
    expect(resolveResult.isError).toBeUndefined();
    expect(resolveResult.content[0]!.text).toContain('"result": "Attached"');
    expect(resolveResult.content[0]!.text).not.toContain("COLD");

    // attach → state set with the expanded root.
    const attachResult = await tools
      .get("twill_attach")!
      .execute("t2", { kind: "Workspace", name: "payments-repo" }, undefined, undefined, undefined);
    expect(attachResult.isError).toBeUndefined();
    expect(attachResult.details["attached"]).toBe(true);
    expect(attachResult.details["root"]).toBe(root);

    // RF#1: the guard now blocks a sibling-repo write, naming the root.
    const blocked = fire(handlers, "tool_call", writeEscape)[0] as GuardVerdict;
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain(root);
    expect(blocked.reason).toContain(escapePath);

    // An in-root write is allowed.
    const writeInside: ToolCallEventShape = {
      type: "tool_call",
      toolCallId: "w2",
      toolName: "write",
      input: { path: join(root, "src", "x.ts"), content: "x" },
    };
    expect(fire(handlers, "tool_call", writeInside)).toEqual([undefined]);

    // session_shutdown clears the attachment (idempotent: fire twice).
    fire(handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" });
    fire(handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" });

    // The guard is inert again — the same escape write passes.
    expect(fire(handlers, "tool_call", writeEscape)).toEqual([undefined]);
  });
});
