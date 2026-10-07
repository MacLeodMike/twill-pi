// The path-scoped write guard (Task 4) — a pi `tool_call` handler that
// blocks write/edit/bash calls whose extracted paths escape the attached
// workspace's root. Registered on the same factory-closure WorkspaceState
// the tools share.
//
// Semantics (in order):
//  1. INERT when unattached (Review Focus #5): no attached workspace →
//     allow everything. This is the FIRST check.
//  2. Only LOCAL routes are enforced. When the attached route is non-local
//     (ssh, k8s-exec), the guard permits everything: a local-process guard
//     cannot see a remote filesystem, so the boundary is advisory-only
//     there (the attach summary tells the model the root).
//  3. Guarded tools: write, edit, bash. read/grep/find/ls and custom tools
//     pass (read-only or pathless).
//
// Path extraction:
//  - write/edit read input.path.
//  - bash scans the command string: whitespace-split tokens, strip common
//    quoting, keep tokens starting with `/` or `~/`. This is the documented
//    CONSERVATIVE-ALLOW tradeoff: the guard catches the common escapes
//    (writing to a sibling repo, `cd /tmp && ...`) but it is NOT a sandbox
//    and does not parse shell — a command with no path tokens is allowed,
//    and command substitutions/subshells can carry paths the scan misses.
//
// Containment is pure path math: `~` expansion + path.resolve (which folds
// `.`/`..`), then the resolved path must equal the root or sit under it.
// Relative paths resolve against pi's process cwd — when cwd is inside the
// root, relative in-cwd paths pass; when cwd is outside, they block. (The
// guard cannot know where a shell `cd` would land for a relative bash path,
// another reason bash is best-effort.) Symlink escapes are out of scope for
// v1 (documented in the plan).

import { resolve, relative, isAbsolute } from "node:path";
import { expandTilde } from "./tools/attach.js";
import type { WorkspaceState } from "./workspace-state.js";

/** pi's tool_call event, typed structurally (same approach as the tools). */
export interface ToolCallEventShape {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** The block verdict; undefined means allow. Matches pi's ToolCallEventResult. */
export interface GuardVerdict {
  block: true;
  reason: string;
}

const GUARDED_TOOLS = new Set(["write", "edit", "bash"]);

/**
 * The tool_call handler. Returns a block verdict when the call's extracted
 * paths escape the attached root; undefined (allow) otherwise.
 */
export function guardToolCall(event: ToolCallEventShape, state: WorkspaceState): GuardVerdict | undefined {
  // Review Focus #5: inert when unattached — FIRST check.
  const workspace = state.current();
  if (workspace === null) return undefined;

  // Non-local routes are advisory-only: a local-process guard cannot see a
  // remote filesystem. The attach summary already tells the model the root.
  if (workspace.route["type"] !== "local") return undefined;

  if (!GUARDED_TOOLS.has(event.toolName)) return undefined;

  const candidates =
    event.toolName === "bash"
      ? bashPathCandidates(typeof event.input["command"] === "string" ? event.input["command"] : "")
      : typeof event.input["path"] === "string"
        ? [event.input["path"]]
        : [];

  // No candidates → allow (a pathless command can't escape by path).
  for (const candidate of candidates) {
    const resolved = resolve(expandTilde(candidate));
    if (!isContained(workspace.root, resolved)) {
      return {
        block: true,
        reason: `twill: ${event.toolName} escapes attached workspace root ${workspace.root} (offending path: ${resolved}). Detach or use paths inside the root.`,
      };
    }
  }
  return undefined;
}

/**
 * True when `resolved` equals `root` or sits under it. path.relative is the
 * containment test: an escaping path yields a relative path starting with
 * `..` (or an absolute path across filesystem roots).
 */
function isContained(root: string, resolved: string): boolean {
  const rel = relative(root, resolved);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Extract path candidates from a bash command string: whitespace-split,
 * strip common quoting, keep tokens starting with `/` or `~/`. Deliberately
 * naive — NOT shell parsing (see the module header for the tradeoff).
 */
function bashPathCandidates(command: string): string[] {
  const candidates: string[] = [];
  for (const rawToken of command.split(/\s+/)) {
    const token = rawToken.replace(/^["']+/, "").replace(/["']+$/, "");
    if (token.startsWith("/") || token.startsWith("~/")) {
      candidates.push(token);
    }
  }
  return candidates;
}
