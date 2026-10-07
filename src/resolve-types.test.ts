// parseResolveResult tests (T2c) — the substrate's core §7/§8 wire parser,
// exercised directly (the T2b suites only reached it through the resolve
// tool, which moved to the kind packages).

import { describe, it, expect } from "vitest";
import { parseResolveResult } from "./resolve-types.js";

const attachedBody = {
  result: "Attached",
  descriptor: {
    kind: "Workspace",
    name: "payments-repo",
    durable_id: "ws_01J8Z4-payments-repo",
    route: { match: { agentLocation: "workstation" }, type: "local", path: "~/repos/payments-repo" },
    status: {
      ready: true,
      provisionable: false,
      claimedBy: [
        {
          name: "claim-x",
          owner: "user:example",
          principal: "pi/0.1.0@workstation",
          claimedOn: { fingerprint: "vol-2c4f1a", durable_id: "ws_01J8Z4-payments-repo" },
        },
      ],
      progress: "mounted",
      asOf: "2026-10-06T12:00:00Z",
      source: "live",
    },
  },
};

describe("parseResolveResult", () => {
  it("parses Attached with the full descriptor (status + claimedBy)", () => {
    const result = parseResolveResult(attachedBody);
    expect(result).toEqual(attachedBody);
  });

  it("parses NoMatch", () => {
    expect(parseResolveResult({ result: "NoMatch" })).toEqual({ result: "NoMatch" });
  });

  it("parses Unreachable with per-route errors", () => {
    const body = {
      result: "Unreachable",
      errors: [{ route: { type: "ssh", address: "talos4" }, reason: "not selectable" }],
    };
    expect(parseResolveResult(body)).toEqual(body);
  });

  it("tolerates a missing errors array on Unreachable (defaults to [])", () => {
    expect(parseResolveResult({ result: "Unreachable" })).toEqual({ result: "Unreachable", errors: [] });
  });

  it("coerces absent descriptor fields to their defaults", () => {
    const result = parseResolveResult({ result: "Attached", descriptor: { status: {} } });
    expect(result).toEqual({
      result: "Attached",
      descriptor: {
        kind: "",
        name: "",
        durable_id: null,
        route: {},
        status: {
          ready: false,
          provisionable: false,
          claimedBy: [],
          progress: "",
          asOf: null,
          source: "live",
        },
      },
    });
  });

  it("throws on a non-record body", () => {
    expect(() => parseResolveResult("nope")).toThrow("malformed resolve result");
    expect(() => parseResolveResult(null)).toThrow("malformed resolve result");
  });

  it("throws on an Attached result without a well-formed descriptor", () => {
    expect(() => parseResolveResult({ result: "Attached" })).toThrow("malformed Attached descriptor");
    expect(() => parseResolveResult({ result: "Attached", descriptor: { status: 42 } })).toThrow(
      "malformed Attached descriptor",
    );
  });

  it("throws on an unknown result tag", () => {
    expect(() => parseResolveResult({ result: "Maybe" })).toThrow("unknown resolve result tag");
  });
});
