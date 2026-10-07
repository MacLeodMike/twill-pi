// twill_claim tool (Task 3) — the cold-workspace wake flow (workspace §6):
// resolve the parent → GET its document (for claimedOn) → POST the claim →
// poll resolve on the materialized child until ready:true → attach it via
// the same WorkspaceState.fromDescriptor path twill_attach uses.
//
// The claim document follows the T2a CLI convention: name
// `claim-<parent>-<principal-sanitized>-<epoch>`, spec.claim.id
// `cl_<epoch>`, spec.claim.route = the parent's resolved route VERBATIM
// (the claim is bound to one provider, §9), spec.parent = the parent
// workspace (claims never name unmaterialized children), claimedOn from
// the parent's spec.workspace.storage (fingerprint + durable id).
//
// Poll target: <parent>-<worktreeName> when worktreeName is given, else
// the parent's own name (claiming a cold root — §6 step 5's no-child
// case). The loop polls every pollIntervalMs until a ready Attached
// descriptor arrives, the timeout (config claimTimeoutMs, per-call
// timeoutMs override) lapses, or pi's abort signal fires. On timeout or
// abort the claim is LEFT IN PLACE (§6 step 6: visibility for operators)
// and the result names it plus the release command.
//
// A claim POST failure (409 name collision, 422 claimedOn mismatch, 409
// missing parent) surfaces the registry's error body in the tool result
// (RegistryError carries it). Transport failures on resolve/GET throw,
// matching the Task-2 tools' convention.
//
// Pi-facing surfaces are typed structurally (see resolve.ts for why).

import { Type, type TObject } from "@sinclair/typebox";
import { RegistryError, type Consumer, type RegistryClient } from "../registry-client.js";
import { WorkspaceState } from "../workspace-state.js";
import { expandTilde } from "./attach.js";
import {
  parseResolveResult,
  type ResolveDescriptor,
  type ToolResult,
} from "./resolve.js";

/** Poll timing for the claim loop (from config; tests inject small values). */
export interface ClaimTimings {
  /** Default timeout (config claimTimeoutMs); the per-call timeoutMs param overrides. */
  claimTimeoutMs: number;
  /** Interval between child resolves (config pollIntervalMs). */
  pollIntervalMs: number;
}

/** The twill_claim tool's shape (its parameter schema differs from TwillTool's kind/name). */
export interface TwillClaimTool {
  name: string;
  label: string;
  description: string;
  parameters: TObject;
  execute(
    toolCallId: string,
    params: { name: string; branch?: string; worktreeName?: string; timeoutMs?: number },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<ToolResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResult(text: string, details: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], details, isError: true };
}

/** Sanitize one claim-name component — the T2a CLI convention (lowercase, [^a-z0-9-]+ → -, edge dashes trimmed). */
export function sanitizeNamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * claimedOn from the workspace document (§6 step 2): durable_id from
 * spec.workspace.storage.id; fingerprint from .fingerprint, omitted when
 * absent (the registry validates the fingerprint only when present).
 */
export function claimedOnFromDoc(doc: unknown, name: string): { fingerprint?: string; durable_id: string } {
  const spec = isRecord(doc) ? doc["spec"] : undefined;
  const workspace = isRecord(spec) ? spec["workspace"] : undefined;
  const storage = isRecord(workspace) ? workspace["storage"] : undefined;
  const durableId = isRecord(storage) ? storage["id"] : undefined;
  if (typeof durableId !== "string" || durableId === "") {
    throw new Error(`Workspace/${name} carries no durable id (spec.workspace.storage.id) — cannot compute claimedOn`);
  }
  const fingerprint = isRecord(storage) ? storage["fingerprint"] : undefined;
  return typeof fingerprint === "string" && fingerprint !== ""
    ? { fingerprint, durable_id: durableId }
    : { durable_id: durableId };
}

/** Read the abort flag. A function (not an inline property access) because
 * TS narrows `signal?.aborted === true` early-return guards to `false | undefined`
 * for the rest of the scope — but `aborted` is a live getter that flips later. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Sleep, waking early when the abort signal fires. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

const DESCRIPTION = [
  "Claim a COLD twill workspace, wait for its provider to materialize it, then attach the result.",
  "Use this when twill_resolve or twill_attach report the workspace cold (status.ready=false). Flow (twill workspace spec §6): resolve the parent, create a Claim bound to the resolved route, poll the materialized workspace until status.ready=true, then attach it.",
  "Parameters: name = the parent Workspace name. branch / worktreeName = provisioning parameters recorded on the claim; with worktreeName the materialized child is <name>-<worktreeName>, without it the parent itself is materialized. timeoutMs overrides the configured claim timeout.",
  "On timeout or abort the claim REMAINS in the registry (visible to operators; the provider may still finish) — the result names the claim and the release command (twill claim release).",
  "Refuses when the workspace is already ready (call twill_attach instead) or not provisionable.",
].join("\n");

/**
 * Build the twill_claim tool. `state` is the session's WorkspaceState from
 * the factory closure (shared with twill_attach and Task 4's guard);
 * `timings` carries the config's claimTimeoutMs/pollIntervalMs.
 */
export function claimTool(
  client: RegistryClient,
  consumer: Consumer,
  state: WorkspaceState,
  timings: ClaimTimings,
): TwillClaimTool {
  return {
    name: "twill_claim",
    label: "twill claim",
    description: DESCRIPTION,
    parameters: Type.Object({
      name: Type.String({ description: "The parent Workspace name (the cold workspace to materialize)." }),
      branch: Type.Optional(Type.String({ description: "Branch to materialize (recorded as the claim's branch parameter)." })),
      worktreeName: Type.Optional(
        Type.String({ description: "Worktree name (claim parameter); the materialized child is <name>-<worktreeName>." }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({ description: "Claim timeout in milliseconds (default: the configured claimTimeoutMs)." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      if (isAborted(signal)) {
        return errorResult("Aborted before anything was claimed — the registry was never contacted.", {
          claimed: false,
          attached: false,
          reason: "aborted",
        });
      }
      if (params.timeoutMs !== undefined && (!Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0)) {
        return errorResult(`Invalid timeoutMs ${params.timeoutMs} — must be a positive number of milliseconds.`, {
          claimed: false,
          attached: false,
          reason: "invalid-params",
        });
      }
      const timeoutMs = params.timeoutMs ?? timings.claimTimeoutMs;

      // §6 step 1: resolve the parent (selection is cheap and non-blocking).
      const parentBody = await client.resolve("Workspace", params.name, consumer);
      const parentResult = parseResolveResult(parentBody);
      if (parentResult.result === "NoMatch") {
        return errorResult(
          `No match: no Workspace named "${params.name}" is registered, or no route matches this consumer (agentLocation=${consumer.agentLocation}). Check the name with twill_resolve.`,
          { claimed: false, attached: false, reason: "NoMatch", result: parentBody },
        );
      }
      if (parentResult.result === "Unreachable") {
        const reasons = parentResult.errors
          .map((e) => `- route ${JSON.stringify(e.route)}: ${e.reason}`)
          .join("\n");
        return errorResult(
          `Unreachable: Workspace/${params.name} has matching routes but none is selectable right now:\n${reasons === "" ? "- (no per-route errors reported)" : reasons}`,
          { claimed: false, attached: false, reason: "Unreachable", result: parentBody },
        );
      }
      const parent = parentResult.descriptor;
      if (parent.status.ready) {
        return errorResult(
          `Workspace/${params.name} is already READY (status.ready=true) — nothing to claim. Call twill_attach to attach it.`,
          { claimed: false, attached: false, reason: "already-ready" },
        );
      }
      if (!parent.status.provisionable) {
        return errorResult(
          `Workspace/${params.name} is cold and NOT provisionable (status.provisionable=false) — its provider cannot lazy-materialize it, so a claim is invalid (workspace §6). Choose another route or workspace.`,
          { claimed: false, attached: false, reason: "not-provisionable", result: parentBody },
        );
      }

      // §6 step 2: GET the workspace document to compute claimedOn.
      const doc = await client.getDoc("Workspace", params.name);
      const claimedOn = claimedOnFromDoc(doc, params.name);

      // §6 step 2: POST the claim (the T2a CLI's document shape).
      const epoch = Math.floor(Date.now() / 1000);
      const claimName = `claim-${sanitizeNamePart(params.name)}-${sanitizeNamePart(consumer.principal)}-${epoch}`;
      const parameters: Record<string, string> = {};
      if (params.branch !== undefined) parameters["branch"] = params.branch;
      if (params.worktreeName !== undefined) parameters["worktreeName"] = params.worktreeName;
      const claimDoc: Record<string, unknown> = {
        apiVersion: "twill.bitwiseoperations.ca/v1alpha1",
        kind: "Claim",
        metadata: { name: claimName },
        spec: {
          owner: consumer.principal,
          routes: [],
          claim: {
            storageBacked: false,
            id: `cl_${epoch}`,
            principal: consumer.principal,
            route: parent.route,
            parameters,
            claimedOn,
            released: false,
          },
          parent: { kind: "Workspace", name: params.name },
        },
        status: {},
      };
      try {
        await client.createClaim(claimName, claimDoc);
      } catch (err) {
        if (err instanceof RegistryError) {
          return errorResult(
            `Claim REJECTED by the registry (HTTP ${err.httpStatus}): ${err.message}\nclaim: ${claimName}`,
            {
              claimed: false,
              attached: false,
              reason: "claim-rejected",
              claimName,
              httpStatus: err.httpStatus,
              serverBody: err.serverBody,
            },
          );
        }
        throw err;
      }

      // §6 step 5: poll the materialized workspace until ready.
      const childName = params.worktreeName !== undefined ? `${params.name}-${params.worktreeName}` : params.name;
      const deadline = Date.now() + timeoutMs;
      const releaseCommand = `twill claim release Workspace ${params.name} ${claimName}`;

      const timeoutResult = (polls: number): ToolResult =>
        errorResult(
          [
            `Timed out: Workspace/${childName} did not report ready within ${timeoutMs} ms (${polls} poll(s)).`,
            `The claim REMAINS VISIBLE in the registry — it was NOT released, and the provider may still be provisioning:`,
            `  claim: ${claimName}`,
            `  parent: Workspace/${params.name}`,
            `To release it explicitly: ${releaseCommand}`,
            `Otherwise leave it and check later with twill_resolve on Workspace/${childName}, then twill_attach once ready.`,
          ].join("\n"),
          { claimed: true, attached: false, reason: "timeout", claimName, childName, timeoutMs, polls, releaseCommand },
        );
      const abortedResult = (polls: number): ToolResult =>
        errorResult(
          [
            `Aborted: stopped polling Workspace/${childName} after ${polls} poll(s).`,
            `The claim REMAINS in the registry — it was NOT released:`,
            `  claim: ${claimName}`,
            `  parent: Workspace/${params.name}`,
            `To release it: ${releaseCommand}`,
          ].join("\n"),
          { claimed: true, attached: false, reason: "aborted", claimName, childName, polls, releaseCommand },
        );

      let polls = 0;
      for (;;) {
        if (isAborted(signal)) return abortedResult(polls);
        if (Date.now() >= deadline) return timeoutResult(polls);
        polls++;
        // NoMatch before the child exists is expected — keep polling.
        const pollBody = await client.resolve("Workspace", childName, consumer);
        const pollResult = parseResolveResult(pollBody);
        if (pollResult.result === "Attached" && pollResult.descriptor.status.ready) {
          return attachReady(pollResult.descriptor, polls);
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return timeoutResult(polls);
        await sleep(Math.min(timings.pollIntervalMs, remaining), signal);
      }

      /** §6 step 5 tail: the workspace reported ready — attach it exactly as twill_attach does. */
      function attachReady(descriptor: ResolveDescriptor, pollCount: number): ToolResult {
        const route = descriptor.route;
        const root = route["type"] === "local" ? expandTilde(String(route["path"] ?? "")) : String(route["path"] ?? "");
        const previous = state.attach(WorkspaceState.fromDescriptor(descriptor, root));

        // RWO advisory (workspace §3), same rule as twill_attach.
        const foreign = descriptor.status.claimedBy.filter((c) => c.principal !== consumer.principal);
        const warning =
          descriptor.status.claimedBy.length > 0 && foreign.length === descriptor.status.claimedBy.length
            ? [
                `WARNING: this workspace is claimed by ${foreign.length} other consumer(s):`,
                ...foreign.map((c) => `- ${c.principal} (claim ${c.name})`),
                `RWO advisory (workspace §3): proceed only deliberately — coordinate before editing.`,
                ``,
              ].join("\n")
            : null;
        const swap =
          previous !== null && previous.name !== descriptor.name
            ? `Replaced the previously attached workspace ${previous.name} (root ${previous.root}).\n`
            : "";

        // Same write-scope phrasing as twill_attach (T2b-2): the guard
        // enforces only local routes; non-local routes are advisory-only.
        const isLocal = route["type"] === "local";
        const text = [
          warning,
          `${swap}Claimed Workspace/${params.name} (claim ${claimName}); the materialized workspace reported ready after ${pollCount} poll(s).`,
          `Attached ${descriptor.kind}/${descriptor.name} (durable_id ${descriptor.durable_id ?? "(none)"}).`,
          `root: ${root}`,
          isLocal
            ? `writes are confined to ${root} — use root-relative paths; the write guard blocks escapes.`
            : `writes should stay under ${root} — use root-relative paths; the write guard is advisory-only for non-local routes (type ${String(route["type"])}): it cannot see a remote filesystem.`,
        ]
          .filter((line) => line !== null && line !== "")
          .join("\n");

        return {
          content: [{ type: "text", text }],
          details: {
            claimed: true,
            attached: true,
            claimName,
            name: descriptor.name,
            durableId: descriptor.durable_id,
            root,
            route,
            parameters,
            polls: pollCount,
            claimedBy: descriptor.status.claimedBy,
            swappedFrom: previous !== null && previous.name !== descriptor.name ? previous.name : null,
            rwoWarning: warning !== null,
          },
        };
      }
    },
  };
}
