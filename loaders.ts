// Lazy core affordances with flat fallbacks. Importing this module starts the
// mark load; a missing module or moved export degrades instead of throwing.

import type { markFramedBlockComponent } from "@oh-my-pi/pi-coding-agent/tui/output-block";

export type MarkFlush = typeof markFramedBlockComponent;
// Core drops its outer wrapper (state tint + 1-col padding) only for
// framed-marked components. The mark is off the extension surface, but the
// package export map exposes the module — load it lazily so a future core
// move degrades to today's tinted card instead of breaking this file.
export let markFlush: MarkFlush | undefined;
import("@oh-my-pi/pi-coding-agent/tui/output-block")
  .then((m) => {
    if (typeof m.markFramedBlockComponent === "function") markFlush = m.markFramedBlockComponent;
  })
  .catch(() => {});
