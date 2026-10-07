// twill_claim tests (Task 3) — the cold-workspace wake flow (workspace §6):
// resolve the parent → GET its document (claimedOn) → POST the claim →
// poll the materialized child until ready → attach it via the same
// WorkspaceState.fromDescriptor path twill_attach uses.
//
// Pinned cases: happy path (child ready on poll 3 → attached), timeout
// (error result names the claim, claim left in place), abort (signal stops
// polling, claim left in place), 409-on-create (the server's error body
// surfaces). Poll intervals + timeouts are injected small.
//
// Harness: the Task 1/2 pattern — a real node:http server on an ephemeral
// port, scripted by request shape. Servers are closed in afterEach.

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { RegistryClient, type Consumer } from "../registry-client.js";
import { WorkspaceState } from "../workspace-state.js";
import { claimTool } from "./claim.js";
import type { ToolResult } from "./resolve.js";

const consumer: Consumer = {
  agentLocation: "workstation",
  agentKind: "pi",
  principal: "pi/0.1.0@workstation",
};

const PARENT = "cold-repo";
const CHILD = "cold-repo-feat-x";

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

// ── Scripted fixtures ───────────────────────────────────────────────────

/** The parent's resolved route — carries a precondition the claim must preserve VERBATIM (provider binding, §9). */
const parentRoute = {
  match: { agentLocation: "workstation" },
  type: "local",
  path: "~/repos/cold-repo",
  precondition: { steps: [{ type: "worktree", repo: ".", branch: "{{claim.parameters.branch}}" }] },
};

/** §6 step 1: the cold case — Attached with ready:false, provisionable:true. */
const coldParentResult = {
  result: "Attached",
  descriptor: {
    kind: "Workspace",
    name: PARENT,
    durable_id: "ws_01J8Z4-cold-repo",
    route: parentRoute,
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

/** The parent document (§6 step 2): claimedOn comes from spec.workspace.storage. */
const parentDoc = {
  apiVersion: "twill.bitwiseoperations.ca/v1alpha1",
  kind: "Workspace",
  metadata: { name: PARENT },
  spec: {
    owner: "user:example",
    workspace: {
      storage: { id: "ws_01J8Z4-cold-repo", fingerprint: "fp-2c4f1a" },
      description: "the cold payments repo",
    },
    routes: [parentRoute],
  },
  status: {},
};

/** Same document without a storage fingerprint (claimedOn omits the key). */
const parentDocNoFingerprint = {
  ...parentDoc,
  spec: {
    ...parentDoc.spec,
    workspace: { ...parentDoc.spec.workspace, storage: { id: "ws_01J8Z4-cold-repo" } },
  },
};

/** §6 step 4: the materialized child — precondition dropped, path replaced, match+type preserved. */
const childRoute = {
  match: { agentLocation: "workstation" },
  type: "local",
  path: "~/repos/cold-repo-feat-x",
};

const readyChildResult = {
  result: "Attached",
  descriptor: {
    kind: "Workspace",
    name: CHILD,
    durable_id: "ws_01J8Z4-cold-repo-feat-x",
    route: childRoute,
    status: {
      ready: true,
      provisionable: false,
      claimedBy: [],
      progress: "materialized",
      asOf: "2026-10-06T12:34:56Z",
      source: "live",
    },
  },
};

interface ScriptOptions {
  /** Answer for the parent resolve (default: always the cold parent). A function is called with the 1-based parent-resolve count. */
  parent?: object | ((resolveCount: number) => unknown);
  /** Answer for GET Workspace/<parent> (default: parentDoc). */
  doc?: unknown;
  /** Answer for POST Claim/<name> (default: 201 echoing the posted document). */
  claim?: (req: RecordedRequest) => { status?: number; body: unknown };
  /** Answer for the child resolve, by 1-based poll number (default: always NoMatch). */
  child?: (poll: number) => unknown;
}

interface ScriptStats {
  childPolls: number;
  claimPosts: number;
}

function script(options: ScriptOptions): { handler: (req: RecordedRequest) => { status?: number; body: unknown }; stats: ScriptStats } {
  const stats: ScriptStats = { childPolls: 0, claimPosts: 0 };
  let parentResolves = 0;
  const handler = (req: RecordedRequest): { status?: number; body: unknown } => {
    if (req.method === "POST" && req.url === "/twill/v1alpha1/resolve") {
      const name = (req.body as { name?: string }).name;
      if (name === PARENT) {
        parentResolves++;
        const parentOption = options.parent;
        const body = typeof parentOption === "function" ? parentOption(parentResolves) : parentOption ?? coldParentResult;
        return { body };
      }
      if (name === CHILD) {
        stats.childPolls++;
        return { body: options.child !== undefined ? options.child(stats.childPolls) : { result: "NoMatch" } };
      }
      return { body: { result: "NoMatch" } };
    }
    if (req.method === "GET" && req.url === `/twill/v1alpha1/Workspace/${PARENT}`) {
      return { body: options.doc ?? parentDoc };
    }
    if (req.method === "POST" && req.url.startsWith("/twill/v1alpha1/Claim/")) {
      stats.claimPosts++;
      return options.claim !== undefined ? options.claim(req) : { status: 201, body: req.body };
    }
    return { status: 404, body: { error: `unscripted request: ${req.method} ${req.url}` } };
  };
  return { handler, stats };
}

/** Build the tool against a scripted registry, with fast poll timing. */
async function makeTool(
  options: ScriptOptions,
  timings: { claimTimeoutMs: number; pollIntervalMs: number } = { claimTimeoutMs: 5_000, pollIntervalMs: 20 },
): Promise<{
  tool: ReturnType<typeof claimTool>;
  state: WorkspaceState;
  requests: RecordedRequest[];
  stats: ScriptStats;
}> {
  const { handler, stats } = script(options);
  const { base, requests } = await boot(handler);
  const state = new WorkspaceState();
  return { tool: claimTool(new RegistryClient(base), consumer, state, timings), state, requests, stats };
}

/** The recorded claim-POST request, asserted to exist. */
function claimPostOf(requests: RecordedRequest[]): RecordedRequest {
  const post = requests.find((r) => r.method === "POST" && r.url.startsWith("/twill/v1alpha1/Claim/"));
  expect(post, "a Claim POST was sent").toBeDefined();
  return post!;
}

describe("twill_claim", () => {
  it("happy path: claims the cold parent, polls until the child reports ready (poll 3), then attaches it", async () => {
    const { tool, state, requests, stats } = await makeTool({
      child: (poll) => (poll >= 3 ? readyChildResult : { result: "NoMatch" }),
    });

    const result = await tool.execute(
      "call-1",
      { name: PARENT, branch: "main", worktreeName: "feat-x" },
      undefined,
      undefined,
      undefined,
    );

    expect(result.isError).toBeFalsy();
    expect(stats.claimPosts).toBe(1);
    expect(stats.childPolls).toBe(3);

    // Attached the CHILD via the shared fromDescriptor path.
    const expectedRoot = `${homedir()}/repos/cold-repo-feat-x`;
    expect(state.current()).toEqual({
      name: CHILD,
      durableId: "ws_01J8Z4-cold-repo-feat-x",
      root: expectedRoot,
      route: childRoute,
      claimedByAtAttach: [],
    });

    const text = textOf(result);
    expect(text).toContain(CHILD);
    expect(text).toContain(expectedRoot);
    expect(text).toContain(`writes are confined to ${expectedRoot}`);
    expect(result.details).toMatchObject({ claimed: true, attached: true, name: CHILD, root: expectedRoot, polls: 3 });

    // The exact request sequence of workspace §6 steps 1-5.
    expect(requests).toHaveLength(6);
    expect(requests[0]).toMatchObject({ method: "POST", url: "/twill/v1alpha1/resolve" });
    expect(requests[0]!.body).toEqual({ kind: "Workspace", name: PARENT, consumer });
    expect(requests[1]).toMatchObject({ method: "GET", url: `/twill/v1alpha1/Workspace/${PARENT}` });
    expect(requests[2]!.method).toBe("POST");
    for (const poll of requests.slice(3)) {
      expect(poll).toMatchObject({ method: "POST", url: "/twill/v1alpha1/resolve" });
      expect(poll.body).toEqual({ kind: "Workspace", name: CHILD, consumer });
    }

    // The claim document: T2a CLI shape, route verbatim (precondition intact), claimedOn from the doc.
    const post = claimPostOf(requests);
    const posted = post.body as Record<string, never> & {
      metadata: { name: string };
      spec: {
        owner: string;
        routes: unknown[];
        parent: unknown;
        claim: Record<string, unknown>;
      };
    };
    expect(posted.apiVersion).toBe("twill.bitwiseoperations.ca/v1alpha1");
    expect(posted.kind).toBe("Claim");
    expect(posted.metadata.name).toMatch(/^claim-cold-repo-pi-0-1-0-workstation-\d+$/);
    expect(post.url).toBe(`/twill/v1alpha1/Claim/${posted.metadata.name}`);
    expect(posted.spec.owner).toBe(consumer.principal);
    expect(posted.spec.routes).toEqual([]);
    expect(posted.spec.parent).toEqual({ kind: "Workspace", name: PARENT });
    expect(posted.spec.claim["storageBacked"]).toBe(false);
    expect(posted.spec.claim["principal"]).toBe(consumer.principal);
    expect(posted.spec.claim["route"]).toEqual(parentRoute);
    expect(posted.spec.claim["parameters"]).toEqual({ branch: "main", worktreeName: "feat-x" });
    expect(posted.spec.claim["claimedOn"]).toEqual({ fingerprint: "fp-2c4f1a", durable_id: "ws_01J8Z4-cold-repo" });
    expect(posted.spec.claim["released"]).toBe(false);
    // The T2a epoch convention ties the name suffix to spec.claim.id.
    const epoch = posted.metadata.name.split("-").pop();
    expect(posted.spec.claim["id"]).toBe(`cl_${epoch}`);

    expect(text).toContain(posted.metadata.name);
  });

  it("timeout: the child never readies → error result names the claim + release command; the claim is left in place", async () => {
    const { tool, state, requests, stats } = await makeTool(
      { doc: parentDocNoFingerprint, child: () => ({ result: "NoMatch" }) },
      { claimTimeoutMs: 120, pollIntervalMs: 20 },
    );

    const result = await tool.execute("call-2", { name: PARENT, worktreeName: "feat-x" }, undefined, undefined, undefined);

    expect(result.isError).toBe(true);
    expect(state.current()).toBeNull();
    expect(stats.childPolls).toBeGreaterThanOrEqual(2);

    const post = claimPostOf(requests);
    const claimName = (post.body as { metadata: { name: string } }).metadata.name;
    const text = textOf(result);
    expect(text).toMatch(/timed out/i);
    expect(text).toContain(claimName);
    expect(text).toMatch(/remains visible/i);
    expect(text).toContain(`twill claim release Workspace ${PARENT} ${claimName}`);
    expect(result.details).toMatchObject({ claimed: true, attached: false, reason: "timeout", claimName, timeoutMs: 120 });

    // claimedOn omits the fingerprint key when the document carries none.
    const posted = post.body as { spec: { claim: { claimedOn: Record<string, unknown> } } };
    expect(posted.spec.claim.claimedOn).toEqual({ durable_id: "ws_01J8Z4-cold-repo" });
    expect("fingerprint" in posted.spec.claim.claimedOn).toBe(false);

    // Left in place = no release was attempted (only resolves followed the POST).
    for (const req of requests.slice(requests.indexOf(post) + 1)) {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/twill/v1alpha1/resolve");
    }
  });

  it("timeoutMs param overrides the configured claimTimeoutMs", async () => {
    const { tool, stats } = await makeTool(
      { child: () => ({ result: "NoMatch" }) },
      { claimTimeoutMs: 60_000, pollIntervalMs: 20 },
    );

    const result = await tool.execute(
      "call-3",
      { name: PARENT, worktreeName: "feat-x", timeoutMs: 100 },
      undefined,
      undefined,
      undefined,
    );

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ reason: "timeout", timeoutMs: 100 });
    // The override bound the loop: nowhere near the 60s default's poll count.
    expect(stats.childPolls).toBeLessThan(50);
  });

  it("abort mid-poll: the signal stops the loop; the claim is left in place and the result says so", async () => {
    const { tool, state, requests, stats } = await makeTool(
      { child: () => ({ result: "NoMatch" }) },
      { claimTimeoutMs: 5_000, pollIntervalMs: 20 },
    );
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 35);

    const result = await tool.execute(
      "call-4",
      { name: PARENT, worktreeName: "feat-x" },
      controller.signal,
      undefined,
      undefined,
    );
    clearTimeout(abort);

    expect(result.isError).toBe(true);
    expect(state.current()).toBeNull();

    const claimName = (claimPostOf(requests).body as { metadata: { name: string } }).metadata.name;
    const text = textOf(result);
    expect(text).toMatch(/abort/i);
    expect(text).toContain(claimName);
    expect(text).toMatch(/remains in the registry|remains visible/i);
    expect(text).toContain(`twill claim release Workspace ${PARENT} ${claimName}`);
    expect(result.details).toMatchObject({ claimed: true, attached: false, reason: "aborted", claimName });

    // The loop STOPPED on the signal instead of running to the 5s timeout.
    expect(stats.childPolls).toBeGreaterThanOrEqual(1);
    expect(stats.childPolls).toBeLessThanOrEqual(10);
    expect(requests.every((r) => r.method !== "PATCH")).toBe(true);
  });

  it("abort before the first request claims nothing and touches no endpoints", async () => {
    const { tool, state, requests, stats } = await makeTool({});
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute(
      "call-5",
      { name: PARENT, worktreeName: "feat-x" },
      controller.signal,
      undefined,
      undefined,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/abort/i);
    expect(result.details).toMatchObject({ claimed: false, attached: false, reason: "aborted" });
    expect(state.current()).toBeNull();
    expect(requests).toHaveLength(0);
    expect(stats.claimPosts).toBe(0);
  });

  it("409 on claim create: the server's error body surfaces in the result; no polling happens", async () => {
    const serverError = "claim already exists: POST against an existing Claim name is rejected";
    const { tool, state, requests, stats } = await makeTool({
      claim: () => ({ status: 409, body: { error: serverError } }),
    });

    const result = await tool.execute("call-6", { name: PARENT, worktreeName: "feat-x" }, undefined, undefined, undefined);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("409");
    expect(text).toContain(serverError);
    expect(result.details).toMatchObject({
      claimed: false,
      attached: false,
      reason: "claim-rejected",
      httpStatus: 409,
      serverBody: { error: serverError },
    });
    expect(state.current()).toBeNull();
    expect(stats.claimPosts).toBe(1);
    // The flow stopped at the rejected POST: resolve parent, GET doc, POST claim — nothing after.
    expect(stats.childPolls).toBe(0);
    expect(requests).toHaveLength(3);
  });

  it("a parent that is already READY refuses and directs to twill_attach (nothing is claimed)", async () => {
    const readyParent = {
      ...coldParentResult,
      descriptor: {
        ...coldParentResult.descriptor,
        status: { ...coldParentResult.descriptor.status, ready: true, provisionable: false, progress: "mounted", asOf: "2026-10-06T12:00:00Z", source: "live" },
      },
    };
    const { tool, state, requests, stats } = await makeTool({ parent: readyParent });

    const result = await tool.execute("call-7", { name: PARENT }, undefined, undefined, undefined);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/already ready/i);
    expect(text).toContain("twill_attach");
    expect(result.details).toMatchObject({ claimed: false, attached: false, reason: "already-ready" });
    expect(state.current()).toBeNull();
    expect(stats.claimPosts).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it("a non-provisionable cold parent refuses (workspace §6: claims are invalid there)", async () => {
    const notProvisionable = {
      ...coldParentResult,
      descriptor: {
        ...coldParentResult.descriptor,
        status: { ...coldParentResult.descriptor.status, provisionable: false },
      },
    };
    const { tool, state, requests, stats } = await makeTool({ parent: notProvisionable });

    const result = await tool.execute("call-8", { name: PARENT }, undefined, undefined, undefined);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/provisionable/i);
    expect(result.details).toMatchObject({ claimed: false, attached: false, reason: "not-provisionable" });
    expect(state.current()).toBeNull();
    expect(stats.claimPosts).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it("NoMatch parent is an error result; nothing is claimed", async () => {
    const { tool, state, requests, stats } = await makeTool({ parent: { result: "NoMatch" } });

    const result = await tool.execute("call-9", { name: PARENT }, undefined, undefined, undefined);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no match/i);
    expect(result.details).toMatchObject({ claimed: false, attached: false, reason: "NoMatch" });
    expect(state.current()).toBeNull();
    expect(stats.claimPosts).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it("with no worktreeName the poll targets the parent's own name (claiming a cold root)", async () => {
    // The provider materializes the ROOT itself: the parent's resolves go
    // cold (initial) → NoMatch-free re-resolve ready on poll 2.
    const readyParentResult = {
      result: "Attached",
      descriptor: {
        kind: "Workspace",
        name: PARENT,
        durable_id: "ws_01J8Z4-cold-repo",
        route: { match: parentRoute.match, type: parentRoute.type, path: parentRoute.path },
        status: { ready: true, provisionable: false, claimedBy: [], progress: "materialized", asOf: "2026-10-06T12:40:00Z", source: "live" },
      },
    };
    const { tool, state, requests, stats } = await makeTool({
      parent: (resolveCount) => (resolveCount >= 3 ? readyParentResult : coldParentResult),
    });

    const result = await tool.execute("call-10", { name: PARENT, branch: "main" }, undefined, undefined, undefined);

    expect(result.isError).toBeFalsy();
    expect(stats.claimPosts).toBe(1);
    expect(stats.childPolls).toBe(0); // no child name was ever polled

    const expectedRoot = `${homedir()}/repos/cold-repo`;
    expect(state.current()).toEqual({
      name: PARENT,
      durableId: "ws_01J8Z4-cold-repo",
      root: expectedRoot,
      route: readyParentResult.descriptor.route,
      claimedByAtAttach: [],
    });

    // Every resolve named the parent (initial + 2 polls).
    const resolves = requests.filter((r) => r.url === "/twill/v1alpha1/resolve");
    expect(resolves).toHaveLength(3);
    for (const req of resolves) {
      expect((req.body as { name: string }).name).toBe(PARENT);
    }

    // parameters carries only branch (no worktreeName key).
    const posted = claimPostOf(requests).body as { spec: { claim: { parameters: Record<string, unknown> } } };
    expect(posted.spec.claim.parameters).toEqual({ branch: "main" });

    const text = textOf(result);
    expect(text).toContain(PARENT);
    expect(text).toContain(`writes are confined to ${expectedRoot}`);
    expect(result.details).toMatchObject({ claimed: true, attached: true, name: PARENT, polls: 2 });
  });
});
