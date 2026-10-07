// Resolve wire types + parser (core §7/§8) — extracted from the T2b
// resolve tool so the substrate exports them without exporting the tool.
// Kind packages (twill-pi-workspace) consume
// these to interpret the registry's resolve answers; the substrate itself
// only parses — the tools that act on the results live in the kind
// packages.
//
// The three result shapes of core §7: Attached with descriptor / NoMatch /
// Unreachable with per-route errors; plus the core §8 status surface.

/** One claim on a status surface (core §9): name, owner, principal, claimedOn. */
export interface ClaimedRef {
  name: string;
  owner: string;
  principal: string;
  claimedOn: { fingerprint?: string; durable_id: string };
}

/** The core §8 status surface (six protocol-fixed fields). */
export interface StatusSurface {
  ready: boolean;
  provisionable: boolean;
  claimedBy: ClaimedRef[];
  progress: string;
  asOf: string | null;
  source: "live" | "cached";
}

/** The core §7.2 Attached descriptor. */
export interface ResolveDescriptor {
  kind: string;
  name: string;
  durable_id: string | null;
  route: Record<string, unknown>;
  status: StatusSurface;
}

/** core §7: the three resolve results. */
export type ResolveResult =
  | { result: "Attached"; descriptor: ResolveDescriptor }
  | { result: "NoMatch" }
  | { result: "Unreachable"; errors: Array<{ route: Record<string, unknown>; reason: string }> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse + validate a resolve response; throws on a malformed body (the registry violated the contract). */
export function parseResolveResult(body: unknown): ResolveResult {
  if (!isRecord(body) || typeof body["result"] !== "string") {
    throw new Error(`malformed resolve result: ${JSON.stringify(body)}`);
  }
  if (body["result"] === "NoMatch") return { result: "NoMatch" };
  if (body["result"] === "Unreachable") {
    const errors: Array<{ route: Record<string, unknown>; reason: string }> = [];
    if (Array.isArray(body["errors"])) {
      for (const entry of body["errors"]) {
        if (isRecord(entry)) {
          errors.push({
            route: isRecord(entry["route"]) ? entry["route"] : {},
            reason: typeof entry["reason"] === "string" ? entry["reason"] : "(no reason)",
          });
        }
      }
    }
    return { result: "Unreachable", errors };
  }
  if (body["result"] === "Attached") {
    const descriptor = body["descriptor"];
    if (!isRecord(descriptor) || !isRecord(descriptor["status"])) {
      throw new Error(`malformed Attached descriptor: ${JSON.stringify(body)}`);
    }
    const status = descriptor["status"];
    const claimedBy: ClaimedRef[] = [];
    if (Array.isArray(status["claimedBy"])) {
      for (const entry of status["claimedBy"]) {
        if (isRecord(entry)) {
          claimedBy.push({
            name: typeof entry["name"] === "string" ? entry["name"] : "",
            owner: typeof entry["owner"] === "string" ? entry["owner"] : "",
            principal: typeof entry["principal"] === "string" ? entry["principal"] : "",
            claimedOn: isRecord(entry["claimedOn"])
              ? (entry["claimedOn"] as ClaimedRef["claimedOn"])
              : { durable_id: "" },
          });
        }
      }
    }
    return {
      result: "Attached",
      descriptor: {
        kind: typeof descriptor["kind"] === "string" ? descriptor["kind"] : "",
        name: typeof descriptor["name"] === "string" ? descriptor["name"] : "",
        durable_id: typeof descriptor["durable_id"] === "string" ? descriptor["durable_id"] : null,
        route: isRecord(descriptor["route"]) ? descriptor["route"] : {},
        status: {
          ready: status["ready"] === true,
          provisionable: status["provisionable"] === true,
          claimedBy,
          progress: typeof status["progress"] === "string" ? status["progress"] : "",
          asOf: typeof status["asOf"] === "string" ? status["asOf"] : null,
          source: status["source"] === "cached" ? "cached" : "live",
        },
      },
    };
  }
  throw new Error(`unknown resolve result tag: ${body["result"]}`);
}
