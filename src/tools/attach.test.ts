// twill_attach tests (Task 2) — resolves (single round-trip, not a stored
// resolve), then: NoMatch/Unreachable → error result; cold → refusal
// directing to twill_claim (Review Focus #3); ready → sets WorkspaceState
// and returns the attached summary. RWO advisory per workspace §3: claimed
// by another principal → attach still SUCCEEDS but carries a visible
// warning naming the claimants.
//
// Harness: the Task 1 pattern — a real node:http server on an ephemeral
// port keyed off the requested name. Servers are closed in afterEach.

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { RegistryClient, type Consumer } from "../registry-client.js";
import { attachTool } from "./attach.js";
import type { ToolResult } from "./resolve.js";
import { WorkspaceState } from "../workspace-state.js";

const consumer: Consumer = {
  agentLocation: "workstation",
  agentKind: "pi",
  principal: "pi/0.1.0@workstation",
};

type RecordedRequest = { method: string; url: string; body: unknown };

const openServers: Server[] = [];

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
  return result.content.map((c: { text: string }) => c.text).join("\n");
}

function attachedResult(
  name: string,
  overrides: { ready?: boolean; path?: string; claimedBy?: unknown[]; routeType?: string } = {},
): Record<string, unknown> {
  const ready = overrides.ready ?? true;
  return {
    result: "Attached",
    descriptor: {
      kind: "Workspace",
      name,
      durable_id: `ws_01J8Z4-${name}`,
      route: {
        match: { agentLocation: "workstation" },
        type: overrides.routeType ?? "local",
        path: overrides.path ?? `~/repos/${name}`,
      },
      status: {
        ready,
        provisionable: !ready,
        claimedBy: overrides.claimedBy ?? [],
        progress: ready ? "mounted" : "workspace registered, no volume yet",
        asOf: ready ? "2026-10-06T12:00:00Z" : null,
        source: ready ? "live" : "cached",
      },
    },
  };
}

const canned: Record<string, unknown> = {
  "payments-repo": attachedResult("payments-repo"),
  "cold-repo": attachedResult("cold-repo", { ready: false }),
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

async function makeTool(): Promise<{
  tool: ReturnType<typeof attachTool>;
  state: WorkspaceState;
  requests: RecordedRequest[];
}> {
  const { base, requests } = await boot((req) => {
    const name = (req.body as { name: string }).name;
    return { body: canned[name] ?? { result: "NoMatch" } };
  });
  const state = new WorkspaceState();
  return { tool: attachTool(new RegistryClient(base), consumer, state), state, requests };
}

describe("twill_attach", () => {
  it("ready workspace attaches: WorkspaceState is set (root = route.path with ~ expanded) and the summary states the write-scope rule", async () => {
    const { tool, state, requests } = await makeTool();

    const result = await tool.execute("call-1", { kind: "Workspace", name: "payments-repo" }, undefined, undefined, undefined);

    expect(result.isError).toBeFalsy();
    const expectedRoot = `${homedir()}/repos/payments-repo`;
    expect(state.current()).toEqual({
      name: "payments-repo",
      durableId: "ws_01J8Z4-payments-repo",
      root: expectedRoot,
      route: (canned["payments-repo"] as { descriptor: { route: unknown } }).descriptor.route,
      claimedByAtAttach: [],
    });

    const text = textOf(result);
    expect(text).toContain("payments-repo");
    expect(text).toContain(expectedRoot);
    // The write-scope rule the model acts on (the Task-4 guard enforces it).
    expect(text).toContain(`writes are confined to ${expectedRoot}`);
    expect(result.details).toMatchObject({ attached: true, name: "payments-repo", root: expectedRoot });

    // Single round-trip: one resolve, no other calls.
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe("/twill/v1alpha1/resolve");
    expect(requests[0]!.body).toEqual({ kind: "Workspace", name: "payments-repo", consumer });
  });

  it("refuses a cold (ready:false) workspace and directs to twill_claim", async () => {
    const { tool, state } = await makeTool();

    const result = await tool.execute("call-2", { kind: "Workspace", name: "cold-repo" }, undefined, undefined, undefined);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/cold/i);
    expect(text).toContain("twill_claim");
    expect(state.current()).toBeNull();
    expect(result.details).toMatchObject({ attached: false, reason: "cold" });
  });

  it("NoMatch is an error result naming the reason; no state is set", async () => {
    const { tool, state } = await makeTool();

    const result = await tool.execute("call-3", { kind: "Workspace", name: "missing" }, undefined, undefined, undefined);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no match/i);
    expect(state.current()).toBeNull();
    expect(result.details).toMatchObject({ attached: false, reason: "NoMatch" });
  });

  it("Unreachable is an error result naming the per-route reason; no state is set", async () => {
    const { tool, state } = await makeTool();

    const result = await tool.execute("call-4", { kind: "Workspace", name: "broken-repo" }, undefined, undefined, undefined);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/unreachable/i);
    expect(text).toContain("not selectable: status reports neither ready nor provisionable");
    expect(state.current()).toBeNull();
    expect(result.details).toMatchObject({ attached: false, reason: "Unreachable" });
  });

  it("RWO advisory: claimed by ANOTHER principal → attach succeeds with a visible warning naming the claimant", async () => {
    const claimedBy = [
      {
        name: "claim-payments-repo-other-1759723200",
        owner: "user:example",
        principal: "hermes/2.0@cluster",
        claimedOn: { fingerprint: "vol-2c4f1a", durable_id: "ws_01J8Z4-payments-repo" },
      },
    ];
    canned["claimed-repo"] = attachedResult("claimed-repo", { claimedBy });
    const { tool, state } = await makeTool();

    const result = await tool.execute("call-5", { kind: "Workspace", name: "claimed-repo" }, undefined, undefined, undefined);

    expect(result.isError).toBeFalsy();
    expect(state.current()?.name).toBe("claimed-repo");
    const text = textOf(result);
    expect(text).toMatch(/warning/i);
    expect(text).toContain("hermes/2.0@cluster");
    expect(text).toContain("claim-payments-repo-other-1759723200");
    // The claims are recorded in state as attachedWithClaims.
    expect(state.current()?.claimedByAtAttach).toEqual(claimedBy);
    delete canned["claimed-repo"];
  });

  it("no RWO warning when the only claim is OUR OWN principal", async () => {
    const claimedBy = [
      {
        name: "claim-own-repo-pi-1759723200",
        owner: "user:example",
        principal: consumer.principal,
        claimedOn: { fingerprint: "vol-2c4f1a", durable_id: "ws_01J8Z4-own-repo" },
      },
    ];
    canned["own-repo"] = attachedResult("own-repo", { claimedBy });
    const { tool } = await makeTool();

    const result = await tool.execute("call-6", { kind: "Workspace", name: "own-repo" }, undefined, undefined, undefined);

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toMatch(/warning/i);
    delete canned["own-repo"];
  });

  it("attaching a second workspace REPLACES the first, and the result notes the swap", async () => {
    const { tool, state } = await makeTool();

    await tool.execute("call-7", { kind: "Workspace", name: "payments-repo" }, undefined, undefined, undefined);
    expect(state.current()?.name).toBe("payments-repo");

    const second = await tool.execute("call-8", { kind: "Workspace", name: "payments-repo" }, undefined, undefined, undefined);
    // same name → not a swap; exercise the real swap with a distinct ready workspace
    expect(textOf(second)).not.toMatch(/replacing/i);

    canned["other-repo"] = attachedResult("other-repo");
    const swapped = await tool.execute("call-9", { kind: "Workspace", name: "other-repo" }, undefined, undefined, undefined);

    expect(state.current()?.name).toBe("other-repo");
    expect(textOf(swapped)).toMatch(/replac/i);
    expect(textOf(swapped)).toContain("payments-repo");
    expect(swapped.details).toMatchObject({ attached: true, name: "other-repo", swappedFrom: "payments-repo" });
    delete canned["other-repo"];
  });
});
