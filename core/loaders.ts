// Lazy core affordances with flat fallbacks. Importing this module starts the
// mark load; a missing module or moved export degrades instead of throwing.

export type MarkFlush = ((component: unknown) => void) | undefined;

let framedSymbol: symbol | undefined;

export let markFlush: MarkFlush = (component: unknown) => {
  if (framedSymbol && typeof component === "object" && component !== null) {
    (component as Record<symbol, unknown>)[framedSymbol] = true;
  }
};

export function setFramedSymbol(sym: symbol): void {
  framedSymbol = sym;
}

export function tryCaptureFramedSymbol(obj: unknown): boolean {
  if (framedSymbol || typeof obj !== "object" || obj === null) return framedSymbol !== undefined;
  for (const sym of Object.getOwnPropertySymbols(obj)) {
    if (sym.description === "framedBlockComponent") {
      setFramedSymbol(sym);
      return true;
    }
  }
  const proto = Object.getPrototypeOf(obj);
  if (proto && proto !== Object.prototype) {
    return tryCaptureFramedSymbol(proto);
  }
  return false;
}

// Core drops its outer wrapper (state tint + 1-col padding) only for
// framed-marked components. The mark is off the extension surface, but the
// package export map exposes the module — load it lazily so a future core
// move degrades to today's tinted card instead of breaking this file.
import("@oh-my-pi/pi-coding-agent")
  .then((m) => {
    if (typeof m.markFramedBlockComponent === "function") {
      const nativeMark = m.markFramedBlockComponent;
      const prev = markFlush;
      markFlush = (component: unknown) => {
        prev?.(component);
        nativeMark(component);
      };
    }
  })
  .catch(() => {});
