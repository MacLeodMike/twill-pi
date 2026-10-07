// Write-guard tests (Task 4) — the tool_call handler blocks write/edit/bash
// calls whose extracted paths escape the attached workspace root, and allows
// everything else. Behavior pins:
//
// - RF#5: INERT when no workspace is attached (the first check).
// - Only LOCAL routes are enforced; non-local routes are advisory-only
//   (a local-process guard cannot see a remote filesystem).
// - write/edit extract input.path; bash scans the command for absolute and
//   ~/ path tokens (conservative: no candidates → allow — NOT a sandbox).
// - Containment is judged on the normalized path (~ expanded, . and ..
//   resolved); the block reason names the attached root and the offending
//   path.
//
// Harness: fabricated tool_call events (pi 1.0.4's discriminated-union
// shape, structurally) + a real WorkspaceState seeded via attach() — no
// registry, no fs (containment is pure path math).

import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { guardToolCall, type ToolCallEventShape } from "./guard.js";
import { WorkspaceState } from "./workspace-state.js";

const ROOT = join(homedir(), "repos", "payments-repo");

// ── Fabricated tool_call events (pi 1.0.4 shapes) ───────────────────────

function writeEvent(path: string): ToolCallEventShape {
  return { type: "tool_call", toolCallId: "c1", toolName: "write", input: { path, content: "x" } };
}

function editEvent(path: string): ToolCallEventShape {
  return { type: "tool_call", toolCallId: "c2", toolName: "edit", input: { path, edits: [] } };
}

function bashEvent(command: string): ToolCallEventShape {
  return { type: "tool_call", toolCallId: "c3", toolName: "bash", input: { command } };
}

function readEvent(path: string): ToolCallEventShape {
  return { type: "tool_call", toolCallId: "c4", toolName: "read", input: { path } };
}

function attachedState(root: string = ROOT, routeType: string = "local"): WorkspaceState {
  const state = new WorkspaceState();
  state.attach({
    name: "payments-repo",
    durableId: "ws_01J8Z4-payments-repo",
    root,
    route: { match: { agentLocation: "workstation" }, type: routeType, path: root },
    claimedByAtAttach: [],
  });
  return state;
}

describe("guardToolCall", () => {
  it("RF#5: INERT when unattached — every tool, even an escaping write, is allowed", () => {
    const state = new WorkspaceState();
    expect(guardToolCall(writeEvent("/etc/passwd"), state)).toBeUndefined();
    expect(guardToolCall(editEvent("/etc/passwd"), state)).toBeUndefined();
    expect(guardToolCall(bashEvent("cd /tmp && make"), state)).toBeUndefined();
  });

  it("RF#1: write to a sibling repo is blocked; the reason names the root and the offending path", () => {
    const state = attachedState();
    const offending = join(homedir(), "repos", "other-repo", "file.ts");

    const result = guardToolCall(writeEvent(offending), state);

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(ROOT);
    expect(result?.reason).toContain(offending);
    expect(result?.reason).toMatch(/twill:/);
    expect(result?.reason).toMatch(/detach/i);
  });

  it("edit to a sibling repo is blocked the same way", () => {
    const state = attachedState();
    const offending = join(homedir(), "repos", "other-repo", "file.ts");

    const result = guardToolCall(editEvent(offending), state);

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(ROOT);
    expect(result?.reason).toContain(offending);
  });

  it("in-root write is allowed", () => {
    const state = attachedState();
    expect(guardToolCall(writeEvent(join(ROOT, "src", "file.ts")), state)).toBeUndefined();
    // The root itself equals the root — contained by definition.
    expect(guardToolCall(writeEvent(ROOT), state)).toBeUndefined();
  });

  it("~/ under the root expands and is allowed; ~/ outside the root is blocked", () => {
    const state = attachedState();
    expect(guardToolCall(writeEvent("~/repos/payments-repo/src/file.ts"), state)).toBeUndefined();

    const result = guardToolCall(writeEvent("~/repos/other-repo/file.ts"), state);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(join(homedir(), "repos", "other-repo", "file.ts"));
  });

  it("../ escape is blocked (normalized before containment is judged)", () => {
    const state = attachedState();
    const result = guardToolCall(writeEvent(join(ROOT, "..", "other-repo", "file.ts")), state);

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(join(homedir(), "repos", "other-repo", "file.ts"));
  });

  it("a sibling sharing the root's name prefix is NOT contained (repos/payments-repo-2)", () => {
    const state = attachedState();
    const result = guardToolCall(writeEvent(join(homedir(), "repos", "payments-repo-2", "file.ts")), state);
    expect(result?.block).toBe(true);
  });

  it("RF#2: bash 'cd /tmp && make' is blocked (/tmp is a path candidate outside the root)", () => {
    const state = attachedState();
    const result = guardToolCall(bashEvent("cd /tmp && make"), state);

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(ROOT);
    expect(result?.reason).toContain("/tmp");
  });

  it("bash with an in-root absolute path is allowed", () => {
    const state = attachedState();
    expect(guardToolCall(bashEvent(`cd ${ROOT} && make test`), state)).toBeUndefined();
  });

  it("bash with NO path candidates is allowed (conservative-allow: the guard is not a sandbox)", () => {
    const state = attachedState();
    expect(guardToolCall(bashEvent("npm test && git status"), state)).toBeUndefined();
    expect(guardToolCall(bashEvent("echo hello world"), state)).toBeUndefined();
  });

  it("bash ~/ candidate under the root is allowed; ~/ outside is blocked", () => {
    const state = attachedState();
    expect(guardToolCall(bashEvent("cat ~/repos/payments-repo/README.md"), state)).toBeUndefined();

    const result = guardToolCall(bashEvent("cat ~/secrets/key.pem"), state);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(join(homedir(), "secrets", "key.pem"));
  });

  it("bash quoted absolute paths are candidates (quoting stripped before the check)", () => {
    const state = attachedState();
    expect(guardToolCall(bashEvent(`cat "${ROOT}/file.txt"`), state)).toBeUndefined();

    const result = guardToolCall(bashEvent("cat '/etc/passwd'"), state);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("/etc/passwd");
  });

  it("read/grep/find/ls are read-only: escaping paths pass", () => {
    const state = attachedState();
    expect(guardToolCall(readEvent("/etc/passwd"), state)).toBeUndefined();
    expect(
      guardToolCall({ type: "tool_call", toolCallId: "c5", toolName: "grep", input: { path: "/etc" } }, state),
    ).toBeUndefined();
    expect(
      guardToolCall({ type: "tool_call", toolCallId: "c6", toolName: "ls", input: { path: "/" } }, state),
    ).toBeUndefined();
  });

  it("custom tools pass (only write/edit/bash are guarded)", () => {
    const state = attachedState();
    expect(
      guardToolCall(
        { type: "tool_call", toolCallId: "c7", toolName: "twill_attach", input: { kind: "Workspace", name: "x" } },
        state,
      ),
    ).toBeUndefined();
  });

  it("non-local routes are ADVISORY-ONLY: an escaping write is allowed when the attached route is ssh", () => {
    const state = attachedState(ROOT, "ssh");
    expect(guardToolCall(writeEvent(join(homedir(), "repos", "other-repo", "file.ts")), state)).toBeUndefined();
    expect(guardToolCall(bashEvent("cd /tmp && make"), state)).toBeUndefined();
  });

  it("relative write paths resolve against pi's cwd: inside when cwd IS the root", () => {
    const state = attachedState(process.cwd());
    expect(guardToolCall(writeEvent("src/guard.ts"), state)).toBeUndefined();
  });

  it("relative write paths resolve against pi's cwd: blocked when cwd is outside the root", () => {
    // The fabricated root is under $HOME; the test runner's cwd (the
    // worktree) is not under it, so a relative path resolves outside.
    const state = attachedState(join(homedir(), "repos", "payments-repo"));
    const result = guardToolCall(writeEvent("src/guard.ts"), state);
    expect(result?.block).toBe(true);
  });
});
