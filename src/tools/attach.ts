// twill_attach tool (Task 2) — resolves (a fresh round-trip; never a stored
// resolve), then: NoMatch/Unreachable → error result naming the reason;
// ready:false → refusal directing to twill_claim (Review Focus #3); ready →
// sets the session's WorkspaceState and returns the attached summary.
//
// RWO advisory (workspace §3): claimedBy non-empty with no claim by OUR
// principal → attach still SUCCEEDS, but the result carries a visible
// warning naming the current claimants.
//
// Attaching a second workspace REPLACES the first; the result notes the
// swap. twill_attach never changes pi's process cwd — the root is enforced
// by the Task-4 write guard, and the model is told to use root-relative
// paths.
//
// Pi-facing surfaces are typed structurally (see resolve.ts for why).

import { homedir } from "node:os";
import { Type } from "@sinclair/typebox";
import type { Consumer, RegistryClient } from "../registry-client.js";
import { WorkspaceState } from "../workspace-state.js";
import {
  parseResolveResult,
  type ClaimedRef,
  type ResolveDescriptor,
  type TwillTool,
} from "./resolve.js";

/**
 * Expand a leading `~` (or `~/…`) against os.homedir(). Only the leading
 * tilde segment is expanded (POSIX: bare `~user` expansion is deliberately
 * not done — twill routes use `~` for the provider host's user).
 */
export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return homedir() + path.slice(1);
  return path;
}

const DESCRIPTION = [
  "Attach a twill workspace to this session, making it the active workspace.",
  "Resolves the name through the twill fabric registry (a fresh resolve every call) and binds the selected route.",
  "Succeeds only when the workspace is ready (status.ready=true). On a cold workspace it refuses — call twill_claim to claim and materialize it, then attach again.",
  "On success: writes are confined to the workspace root (the write guard enforces this), and the summary names the root — use root-relative paths from then on; pi's cwd does not change.",
  "Attaching while another workspace is attached replaces it (the result notes the swap).",
  "If other consumers hold claims on the workspace (RWO advisory), the attach still succeeds but the result carries a WARNING naming the claimants.",
].join("\n");

/**
 * Build the twill_attach tool. `state` is the session's WorkspaceState from
 * the factory closure (Task 3's claim-attach and Task 5's lifecycle share it).
 */
export function attachTool(client: RegistryClient, consumer: Consumer, state: WorkspaceState): TwillTool {
  return {
    name: "twill_attach",
    label: "twill attach",
    description: DESCRIPTION,
    parameters: Type.Object({
      kind: Type.String({ description: "The object kind (e.g. \"Workspace\")." }),
      name: Type.String({ description: "The object name (document metadata.name)." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const body = await client.resolve(params.kind, params.name, consumer);
      const result = parseResolveResult(body);

      if (result.result === "NoMatch") {
        return {
          content: [
            {
              type: "text",
              text: `No match: no ${params.kind} named "${params.name}" is registered, or no route matches this consumer (agentLocation=${consumer.agentLocation}). Check the name with twill_resolve, or list workspaces with the twill CLI.`,
            },
          ],
          details: { attached: false, reason: "NoMatch", result: body },
          isError: true,
        };
      }

      if (result.result === "Unreachable") {
        const reasons = result.errors
          .map((e) => `- route ${JSON.stringify(e.route)}: ${e.reason}`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `Unreachable: ${params.kind}/${params.name} has matching routes but none is selectable right now:\n${reasons === "" ? "- (no per-route errors reported)" : reasons}`,
            },
          ],
          details: { attached: false, reason: "Unreachable", result: body },
          isError: true,
        };
      }

      const descriptor = result.descriptor;

      // Review Focus #3: cold workspaces are refused, not attached.
      if (!descriptor.status.ready) {
        return {
          content: [
            {
              type: "text",
              text: [
                `Refused: ${descriptor.kind}/${descriptor.name} is COLD (status.ready=false) — it cannot be attached yet.`,
                descriptor.status.progress !== "" ? `progress: ${descriptor.status.progress}` : undefined,
                `Call twill_claim to claim and materialize it, then call twill_attach again.`,
              ]
                .filter((line) => line !== undefined)
                .join("\n"),
            },
          ],
          details: { attached: false, reason: "cold", result: body },
          isError: true,
        };
      }

      // Local routes root the workspace at route.path (with ~ expanded);
      // non-local routes are advisory-only for the Task-4 guard, but the
      // root still records the declared path for the summary/state.
      const route = descriptor.route;
      const root = route["type"] === "local" ? expandTilde(String(route["path"] ?? "")) : String(route["path"] ?? "");

      const previous = state.attach(WorkspaceState.fromDescriptor(descriptor, root));

      // RWO advisory (workspace §3): non-empty claimedBy, none of them ours.
      const foreignClaims = foreignClaimants(descriptor.status.claimedBy, consumer.principal);
      const warning =
        descriptor.status.claimedBy.length > 0 && foreignClaims.length === descriptor.status.claimedBy.length
          ? [
              `WARNING: this workspace is claimed by ${foreignClaims.length} other consumer(s):`,
              ...foreignClaims.map((c) => `- ${c.principal} (claim ${c.name})`),
              `RWO advisory (workspace §3): proceed only deliberately — coordinate before editing.`,
              ``,
            ].join("\n")
          : null;

      const swap =
        previous !== null && previous.name !== descriptor.name
          ? `Replaced the previously attached workspace ${previous.name} (root ${previous.root}).\n`
          : "";

      const text = [
        warning,
        `${swap}Attached ${descriptor.kind}/${descriptor.name} (durable_id ${descriptor.durable_id ?? "(none)"}).`,
        `root: ${root}`,
        `writes are confined to ${root} — use root-relative paths; the write guard blocks escapes.`,
        `pi's cwd is unchanged; the guard enforces the root, not the shell's working directory.`,
      ]
        .filter((line) => line !== null && line !== "")
        .join("\n");

      return {
        content: [{ type: "text", text }],
        details: {
          attached: true,
          name: descriptor.name,
          durableId: descriptor.durable_id,
          root,
          route,
          claimedBy: descriptor.status.claimedBy,
          swappedFrom: previous !== null && previous.name !== descriptor.name ? previous.name : null,
          rwoWarning: warning !== null,
        },
      };
    },
  };
}

/** Claims whose principal is NOT ours (the RWO warning names these). */
function foreignClaimants(claimedBy: ClaimedRef[], ourPrincipal: string): ClaimedRef[] {
  return claimedBy.filter((c) => c.principal !== ourPrincipal);
}

// Re-export so consumers of the attach path (Task 3's claim-attach) can
// build state entries without importing two modules.
export type { ResolveDescriptor };
