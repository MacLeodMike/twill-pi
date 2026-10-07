// RegistryClient tests (T2b) — a thin fetch consumer of the twill
// registry's HTTP surface, verified against a real node:http server on an
// ephemeral port (the twill repo's server.test.ts harness pattern: real
// HTTP, canned handlers, no fetch mocks).
//
// Every request the server receives is recorded so tests can assert the
// request SHAPE (method, path+query, body) alongside response handling.
// Servers are closed in afterEach so vitest exits cleanly.

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { RegistryClient, type Consumer } from "./registry-client.js";

const consumer: Consumer = { agentLocation: "workstation", agentKind: "pi", principal: "pi/0.1.0@workstation" };

type RecordedRequest = { method: string; url: string; body: unknown };
type Handler = (req: RecordedRequest) => { status?: number; body: unknown };

type Boot = { base: string; requests: RecordedRequest[] };

const openServers: Server[] = [];

/** Boot a canned registry on an ephemeral port; every request is recorded, then answered by `handler`. */
async function boot(handler: Handler): Promise<Boot> {
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
      const payload = JSON.stringify(answer.body);
      res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      res.end(payload);
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

const attachedResult = {
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

/** A claim envelope as the registry serves it from GET /claims (doc.raw verbatim). */
function claimEnvelope(name: string, parentName: string, released: boolean): Record<string, unknown> {
  return {
    apiVersion: "twill.bitwiseoperations.ca/v1alpha1",
    kind: "Claim",
    metadata: { name },
    spec: {
      owner: "user:example",
      routes: [],
      claim: {
        storageBacked: false,
        id: `cl_test-${name}`,
        principal: consumer.principal,
        route: { type: "local", path: "~/repos/payments-repo" },
        parameters: { branch: "feat-x", worktreeName: "feat-x" },
        claimedOn: { fingerprint: "vol-2c4f1a", durable_id: "ws_01J8Z4-payments-repo" },
        released,
      },
      parent: { kind: "Workspace", name: parentName },
    },
    status: {},
  };
}

describe("resolve", () => {
  it("POSTs {kind, name, consumer} to /resolve and returns the parsed result", async () => {
    const { base, requests } = await boot(() => ({ body: attachedResult }));
    const client = new RegistryClient(base);
    const result = await client.resolve("Workspace", "payments-repo", consumer);

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/twill/v1alpha1/resolve");
    expect(req.body).toEqual({ kind: "Workspace", name: "payments-repo", consumer });
    expect(result).toEqual(attachedResult);
  });

  it("parses all three result shapes (Attached, NoMatch, Unreachable)", async () => {
    const shapes: unknown[] = [
      attachedResult,
      { result: "NoMatch" },
      {
        result: "Unreachable",
        errors: [{ route: { type: "ssh", address: "talos4" }, error: "not selectable" }],
      },
    ];
    // One response shape per call, in order.
    let next = 0;
    const { base } = await boot(() => {
      const body = shapes[Math.min(next, shapes.length - 1)];
      next += 1;
      return { body };
    });
    const client = new RegistryClient(base);
    for (const shape of shapes) {
      expect(await client.resolve("Workspace", "payments-repo", consumer)).toEqual(shape);
    }
  });

  it("strips a trailing slash from the base URL", async () => {
    const { base, requests } = await boot(() => ({ body: attachedResult }));
    const client = new RegistryClient(`${base}/`);
    await client.resolve("Workspace", "payments-repo", consumer);
    expect(requests[0]!.url).toBe("/twill/v1alpha1/resolve");
  });
});

describe("getDoc", () => {
  it("GETs /<kind>/<name> (segments encoded) and returns the parsed envelope", async () => {
    const doc = {
      apiVersion: "twill.bitwiseoperations.ca/v1alpha1",
      kind: "Workspace",
      metadata: { name: "payments-repo" },
      spec: { workspace: { storage: { id: "ws_01J8Z4-payments-repo", fingerprint: "vol-2c4f1a" } } },
      status: {},
    };
    const { base, requests } = await boot(() => ({ body: doc }));
    const client = new RegistryClient(base);
    const result = await client.getDoc("Workspace", "payments-repo");

    const req = requests[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/twill/v1alpha1/Workspace/payments-repo");
    expect(result).toEqual(doc);
  });

  it("encodes kind and name path segments", async () => {
    const { base, requests } = await boot(() => ({ body: {} }));
    const client = new RegistryClient(base);
    await client.getDoc("Workspace", "feat x/y");
    expect(requests[0]!.url).toBe(`/twill/v1alpha1/Workspace/${encodeURIComponent("feat x/y")}`);
  });
});

describe("createClaim", () => {
  it("POSTs the claim document to /Claim/<name> verbatim (name encoded)", async () => {
    const doc = claimEnvelope("claim-payments-repo-pi-1759723200", "payments-repo", false);
    const { base, requests } = await boot(() => ({ status: 201, body: doc }));
    const client = new RegistryClient(base);
    const result = await client.createClaim("claim-payments-repo-pi-1759723200", doc);

    const req = requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/twill/v1alpha1/Claim/claim-payments-repo-pi-1759723200");
    expect(req.body).toEqual(doc);
    expect(result).toEqual(doc);
  });
});

describe("listClaims", () => {
  it("GETs /claims?parent=<kind>/<name> with the parent query-encoded as one value", async () => {
    const claims = [claimEnvelope("claim-a", "payments-repo", false)];
    const { base, requests } = await boot(() => ({ body: claims }));
    const client = new RegistryClient(base);
    const result = await client.listClaims("Workspace", "payments-repo");

    const req = requests[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/twill/v1alpha1/claims?parent=Workspace%2Fpayments-repo");
    expect(result).toEqual(claims);
  });

  it("passes includeReleased=true when asked", async () => {
    const { base, requests } = await boot(() => ({ body: [] }));
    const client = new RegistryClient(base);
    await client.listClaims("Workspace", "payments-repo", { includeReleased: true });
    expect(requests[0]!.url).toBe("/twill/v1alpha1/claims?parent=Workspace%2Fpayments-repo&includeReleased=true");
  });

  it("encodes a parent name carrying special characters inside the query value", async () => {
    const { base, requests } = await boot(() => ({ body: [] }));
    const client = new RegistryClient(base);
    await client.listClaims("Workspace", "feat x&y");
    expect(requests[0]!.url).toBe(`/twill/v1alpha1/claims?parent=${encodeURIComponent("Workspace/feat x&y")}`);
  });
});

describe("releaseClaim (the T2a pattern: parent-scoped lookup + PATCH)", () => {
  it("looks the claim up via GET /claims?parent=…&includeReleased=true, then PATCHes it with only released flipped", async () => {
    const stored = claimEnvelope("claim-a", "payments-repo", false);
    const { base, requests } = await boot((req) => {
      if (req.method === "GET") return { body: [stored] };
      return { body: { ...stored, spec: { ...(stored.spec as object), claim: { released: true } } } };
    });
    const client = new RegistryClient(base);
    await client.releaseClaim("Workspace", "payments-repo", "claim-a");

    expect(requests).toHaveLength(2);
    const [lookup, patch] = requests as [RecordedRequest, RecordedRequest];
    expect(lookup.method).toBe("GET");
    expect(lookup.url).toBe("/twill/v1alpha1/claims?parent=Workspace%2Fpayments-repo&includeReleased=true");
    expect(patch.method).toBe("PATCH");
    expect(patch.url).toBe("/twill/v1alpha1/Claim/claim-a");
    // The PATCH body is the stored envelope with spec.claim.released true —
    // and nothing else changed.
    const body = patch.body as Record<string, unknown>;
    const spec = body["spec"] as Record<string, unknown>;
    const claim = spec["claim"] as Record<string, unknown>;
    expect(claim["released"]).toBe(true);
    const expected = JSON.parse(JSON.stringify(stored)) as { spec: { claim: Record<string, unknown> } };
    expected.spec.claim["released"] = true;
    expect(body).toEqual(expected);
  });

  it("throws when the claim is not found under the parent", async () => {
    const { base } = await boot(() => ({ body: [] }));
    const client = new RegistryClient(base);
    await expect(client.releaseClaim("Workspace", "payments-repo", "claim-missing")).rejects.toThrow("claim-missing");
  });
});

describe("health", () => {
  it("GETs /health and returns the parsed report", async () => {
    const report = {
      documentSet: "current",
      warnings: [{ type: "overlay-corrupt-line", line: 2 }],
    };
    const { base, requests } = await boot(() => ({ body: report }));
    const client = new RegistryClient(base);
    const health = await client.health();

    const req = requests[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/twill/v1alpha1/health");
    expect(health.documentSet).toBe("current");
    expect(health.warnings).toEqual(report.warnings);
  });

  it("carries rejectedAt/reason when the set is stale", async () => {
    const report = {
      documentSet: "stale",
      rejectedAt: "2026-10-07T01:00:00Z",
      reason: "fingerprint collision",
      warnings: [],
    };
    const { base } = await boot(() => ({ body: report }));
    const client = new RegistryClient(base);
    const health = await client.health();
    expect(health).toEqual(report);
  });

  it("throws on a malformed report (missing documentSet/warnings)", async () => {
    const { base } = await boot(() => ({ body: { ok: true } }));
    const client = new RegistryClient(base);
    await expect(client.health()).rejects.toThrow("malformed health report");
  });

  it("throws RegistryError on a non-2xx answer", async () => {
    const { base } = await boot(() => ({ status: 500, body: { error: "boom" } }));
    const client = new RegistryClient(base);
    await expect(client.health()).rejects.toThrow("registry answered HTTP 500: boom");
  });
});

describe("HTTP errors", () => {
  it("throw an error carrying the server's error body", async () => {
    const { base } = await boot(() => ({ status: 404, body: { error: "no such document: Workspace/nope" } }));
    const client = new RegistryClient(base);
    const err = await client.getDoc("Workspace", "nope").then(
      () => {
        throw new Error("should have thrown");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("404");
    expect((err as Error).message).toContain("no such document: Workspace/nope");
  });

  it("claim conflicts surface the server's error body (409)", async () => {
    const { base } = await boot(() => ({
      status: 409,
      body: { error: "claim claim-a already exists" },
    }));
    const client = new RegistryClient(base);
    await expect(client.createClaim("claim-a", claimEnvelope("claim-a", "payments-repo", false))).rejects.toThrow(
      "claim claim-a already exists",
    );
  });
});
