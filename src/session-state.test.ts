// KindSessionState tests (T2c) — the generic per-kind attach-state
// container. The substrate provides the CLASS, never an instance: each kind
// package (twill-pi-workspace) instantiates its own in its factory closure,
// so per-instance isolation is part of the contract under test.

import { describe, it, expect } from "vitest";
import { KindSessionState } from "./session-state.js";

describe("KindSessionState", () => {
  it("starts empty (current() is null before any attach)", () => {
    const state = new KindSessionState<string>();
    expect(state.current()).toBeNull();
  });

  it("attach(v) makes current() return v", () => {
    const state = new KindSessionState<{ name: string }>();
    const value = { name: "payments-repo" };
    state.attach(value);
    expect(state.current()).toBe(value);
  });

  it("attaching a second value replaces the first", () => {
    const state = new KindSessionState<string>();
    state.attach("a");
    state.attach("b");
    expect(state.current()).toBe("b");
  });

  it("detach clears the attachment and is idempotent", () => {
    const state = new KindSessionState<string>();
    state.detach(); // never attached — no-op
    state.attach("a");
    state.detach();
    expect(state.current()).toBeNull();
    state.detach();
    expect(state.current()).toBeNull();
  });

  it("instances are independent (per-kind containers, not shared module state)", () => {
    const a = new KindSessionState<string>();
    const b = new KindSessionState<string>();
    a.attach("ws");
    expect(a.current()).toBe("ws");
    expect(b.current()).toBeNull();
  });
});
