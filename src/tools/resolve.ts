// twill_resolve tool (Task 2) — passes the registry's ResolveResult through
// to the model verbatim as JSON text (core §7.2: the descriptor is the
// contract), with one model-facing note when the selected descriptor is not
// ready (Review Focus #3: a cold workspace is NOT attachable — the note says
// so and directs the model to twill_claim).
//
// The resolve WIRE TYPES live here too (attach.ts and workspace-state.ts
// consume them): the three result shapes of core §7 (Attached with
// descriptor / NoMatch / Unreachable with per-route errors) and the status
// surface (core §8).
//
// The pi-facing surface is typed structurally (not imported from pi
// packages) so the module typechecks and its tests run outside pi; pi's
// real ToolDefinition satisfies this shape at load time (verified against
// pi 1.0.4's dist/core/extensions/types.d.ts).

import { Type, type TObject, type TString } from "@sinclair/typebox";
import type { Consumer, RegistryClient } from "../registry-client.js";

/** The model-facing tool result (structural pi AgentToolResult: content + details). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  /** Structured state for rendering/state reconstruction (pi `details`). */
  details: Record<string, unknown>;
  /** pi marks the result failed; the model still sees content. */
  isError?: boolean;
}

/** The structural minimum of pi's ToolDefinition this extension registers. */
export interface TwillTool {
  name: string;
  label: string;
  description: string;
  parameters: TObject<{ kind: TString; name: TString }>;
  execute(
    toolCallId: string,
    params: { kind: string; name: string },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<ToolResult>;
}

// ── Resolve wire types (core §7/§8) ─────────────────────────────────────

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

// ── twill_resolve ────────────────────────────────────────────────────────

const DESCRIPTION = [
  "Resolve a twill object (usually a Workspace) through the twill fabric registry.",
  "Use it to look up an object before attaching, or to check a workspace's status (cold/ready, claims).",
  "The result is the registry's ResolveResult verbatim (JSON):",
  "- Attached: a route selected — descriptor.route + descriptor.status (ready, claimedBy, progress).",
  "  status.ready=true means twill_attach can attach it now; ready=false means the workspace is COLD — call twill_claim to materialize it, then attach.",
  "- NoMatch: no object by that name, or no route matches this consumer.",
  "- Unreachable: matching routes exist but none is selectable (provider not reporting ready/provisionable); per-route errors are listed.",
].join("\n");

/**
 * Build the twill_resolve tool. The client + consumer are the Task-1
 * config-derived pair; the tool adds no state of its own.
 */
export function resolveTool(client: RegistryClient, consumer: Consumer): TwillTool {
  return {
    name: "twill_resolve",
    label: "twill resolve",
    description: DESCRIPTION,
    parameters: Type.Object({
      kind: Type.String({ description: "The object kind (e.g. \"Workspace\")." }),
      name: Type.String({ description: "The object name (document metadata.name)." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const body = await client.resolve(params.kind, params.name, consumer);
      const result = parseResolveResult(body);
      const json = JSON.stringify(body, null, 2);

      // Review Focus #3: cold workspaces must not read as attachable.
      if (result.result === "Attached" && !result.descriptor.status.ready) {
        const d = result.descriptor;
        const note = [
          `NOTE: ${d.kind}/${d.name} is COLD (status.ready=false).`,
          `It is NOT attachable yet — call twill_claim to claim and materialize it, then attach.`,
          d.status.progress !== "" ? `progress: ${d.status.progress}` : undefined,
          ``,
        ]
          .filter((line) => line !== undefined)
          .join("\n");
        return { content: [{ type: "text", text: `${note}\n${json}` }], details: body as Record<string, unknown> };
      }

      return { content: [{ type: "text", text: json }], details: body as Record<string, unknown> };
    },
  };
}
