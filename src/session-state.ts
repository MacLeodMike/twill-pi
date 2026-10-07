// KindSessionState<T> (T2c) — the generic per-kind attach-state container.
//
// The substrate exports the CLASS, never an instance. Pi loads installed
// packages with separate module roots (pi docs: packages.md), so a
// module-level singleton here would not be shared with a consuming kind
// package anyway — each kind package (e.g. twill-pi-workspace) instantiates
// its own in its factory closure and hands it to the tools/guards it
// registers. The payload type T is the kind's own (twill-pi-workspace:
// its AttachedWorkspace).
//
// One attachment at a time: attaching a second value replaces the first.
// detach is idempotent — lifecycle handlers (session_shutdown) may fire
// without a prior attach.

export class KindSessionState<T> {
  private active: T | null = null;

  /** The current attachment, or null when unattached. */
  current(): T | null {
    return this.active;
  }

  /** Set the current attachment, replacing any previous one. */
  attach(value: T): void {
    this.active = value;
  }

  /** Clear the current attachment (idempotent). */
  detach(): void {
    this.active = null;
  }
}
