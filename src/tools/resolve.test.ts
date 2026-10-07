// twill_resolve tests (Task 2) — the tool passes the registry's
// ResolveResult through to the model verbatim (core §7.2: the descriptor is
// the contract), with a cold-workspace note when the attached descriptor is
// not ready (Review Focus #3: the model must NOT treat cold as attachable —
// the note directs it to twill_claim).
//
// Harness: the Task 1 pattern — a real node:http server on an ephemeral
// port serving canned ResolveResults, keyed off the requested name. Servers
// are closed in afterEach so vitest exits cleanly.

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { RegistryClient, type Consumer } from "../registry-client.js";
import { resolveTool, type ToolResult } from "./resolve.js";
import twillPi from "../../index.js";

const consumer: Consumer = {
  agentLocation: "workstation",
  agentKind: "pi",
  principal: "pi/0.1.0@workstation",
};

type RecordedRequest = { method: string; url: string; body: unknown };

const openServers: Server[] = [];

/** Boot a canned registry on an ephemeral port; every request is recorded, then answered by `handler`. */
async function boot(handler: (req: RecordedRequest) => { status?: number; body: unknown }): Promise<{
  base: string;
  requests: RecordedRequest[];
}> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        body = text;
      }
      const recorded: RecordedRequest = { method: req.method ?? "", url: req.url ?? "", body };
      requests.push(recorded);
      const answer = handler(recorded);
      res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  openServers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { base: `http://127.0.0.1:${port}/twill/v1alpha1`, requests };
}

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

const readyAttached = {
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

const coldAttached = {
  result: "Attached",
  descriptor: {
    kind: "Workspace",
    name: "cold-repo",
    durable_id: "ws_01J8Z4-cold-repo",
    route: { match: { agentLocation: "workstation" }, type: "local", path: "~/repos/cold-repo" },
    status: {
      ready: false,
      provisionable: true,
      claimedBy: [],
      progress: "workspace registered, no volume yet",
      asOf: null,
      source: "cached",
    },
  },
};

const canned: Record<string, unknown> = {
  "payments-repo": readyAttached,
  "cold-repo": coldAttached,
  missing: { result: "NoMatch" },
  "broken-repo": {
    result: "Unreachable",
    errors: [
      {
        route: { match: { agentLocation: "workstation" }, type: "local", path: "~/repos/broken-repo" },
        reason: "not selectable: status reports neither ready nor provisionable",
      },
    ],
  },
};

describe("twill_resolve", () => {
  it("passes the ResolveResult through verbatim as JSON text (ready Attached)", async () => {
    const { base, requests } = await boot((req) => {
      const name = (req.body as { name: string }).name;
      return { body: canned[name] ?? { result: "NoMatch" } };
    });
    const tool = resolveTool(new RegistryClient(base), consumer);

    const result = await tool.execute("call-1", { kind: "Workspace", name: "payments-repo" }, undefined, undefined, undefined);

    // The model-facing text IS the verbatim registry result (JSON).
    expect(textOf(result)).toBe(JSON.stringify(readyAttached, null, 2));
    expect(result.details).toEqual(readyAttached);
    expect(result.isError).toBeFalsy();
    // …and the request went to the registry with the declared consumer.
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe("/twill/v1alpha1/resolve");
    expect(requests[0]!.body).toEqual({ kind: "Workspace", name: "payments-repo", consumer });
  });

  it("on Attached with status.ready=false, the text says the workspace is cold and directs to twill_claim", async () => {
    const { base } = await boot(() => ({ body: coldAttached }));
    const tool = resolveTool(new RegistryClient(base), consumer);

    const result = await tool.execute("call-2", { kind: "Workspace", name: "cold-repo" }, undefined, undefined, undefined);

    const text = textOf(result);
    expect(text).toMatch(/cold/i);
    expect(text).toContain("twill_claim");
    // The verbatim result is still carried (details + JSON tail of the text).
    expect(result.details).toEqual(coldAttached);
    expect(JSON.parse(text.slice(text.indexOf("{")))).toEqual(coldAttached);
  });

  it("passes NoMatch and Unreachable through verbatim as JSON text", async () => {
    const { base } = await boot((req) => {
      const name = (req.body as { name: string }).name;
      return { body: canned[name] ?? { result: "NoMatch" } };
    });
    const tool = resolveTool(new RegistryClient(base), consumer);

    const noMatch = await tool.execute("call-3", { kind: "Workspace", name: "missing" }, undefined, undefined, undefined);
    expect(textOf(noMatch)).toBe(JSON.stringify(canned["missing"], null, 2));
    expect(noMatch.details).toEqual(canned["missing"]);

    const unreachable = await tool.execute("call-4", { kind: "Workspace", name: "broken-repo" }, undefined, undefined, undefined);
    expect(textOf(unreachable)).toBe(JSON.stringify(canned["broken-repo"], null, 2));
    expect(unreachable.details).toEqual(canned["broken-repo"]);
  });
});

describe("extension factory (Task 3 + Task 4 + Task 5 wiring)", () => {
  it("registers the three tools, the tool_call write guard, and the session_shutdown detach", () => {
    const registered: string[] = [];
    const handlers: string[] = [];
    twillPi({
      registerTool(tool: unknown) {
        registered.push((tool as { name: string }).name);
      },
      on(event: string, _handler: unknown) {
        handlers.push(event);
        return () => {};
      },
    });
    expect(registered).toEqual(["twill_resolve", "twill_attach", "twill_claim"]);
    expect(handlers).toEqual(["tool_call", "session_shutdown"]);
  });
});
