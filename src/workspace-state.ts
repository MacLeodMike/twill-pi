// WorkspaceState (Task 2) — the session's active workspace, held by the
// extension factory closure (registered tools + the Task-4 write guard all
// read it). One workspace at a time: attaching a second replaces the first.
//
// The shape is what the Task-4 guard needs for root-containment checks
// (root, expanded at attach time) plus what Task 3's claim-attach reuses
// (route, claimedBy snapshot).

import type { ClaimedRef, ResolveDescriptor } from "./tools/resolve.js";

/** The session's attached workspace. */
export interface AttachedWorkspace {
  /** Workspace name (document metadata.name). */
  name: string;
  /** The core §7.2 descriptor's durable_id (cap identity); null when the document carries none. */
  durableId: string | null;
  /** Filesystem root the Task-4 guard confines writes to (route.path with ~ expanded for local routes). */
  root: string;
  /** The resolved route verbatim from the descriptor. */
  route: Record<string, unknown>;
  /** claimedBy as observed at attach time (the RWO advisory snapshot — workspace §3). */
  claimedByAtAttach: ClaimedRef[];
}

/**
 * The session's active workspace. `attach` returns the replaced workspace
 * (or null) so the caller can note the swap; `detach` clears it
 * (session_shutdown, Task 5).
 */
export class WorkspaceState {
  private active: AttachedWorkspace | null = null;

  current(): AttachedWorkspace | null {
    return this.active;
  }

  /** Set the active workspace, returning the one it replaced (null on first attach). */
  attach(workspace: AttachedWorkspace): AttachedWorkspace | null {
    const previous = this.active;
    this.active = workspace;
    return previous;
  }

  /** Clear the active workspace (idempotent). */
  detach(): void {
    this.active = null;
  }

  /** Build the AttachedWorkspace from a resolved descriptor (shared by twill_attach and Task 3's claim-attach). */
  static fromDescriptor(descriptor: ResolveDescriptor, root: string): AttachedWorkspace {
    return {
      name: descriptor.name,
      durableId: descriptor.durable_id,
      root,
      route: descriptor.route,
      claimedByAtAttach: descriptor.status.claimedBy,
    };
  }
}
