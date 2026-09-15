// Skin for core's native ReadToolGroupComponent (grouped filesystem reads).
// Core instantiates this component when renderToolName === "read" and the args
// collapse into a group, returning before ToolExecutionComponent exists — so
// the wrapped-read renderCall/renderResult never run for this path. Skinning
// at Container.addChild time repaints the card with formatRowLine while
// leaving execution, grouping, and Ctrl+O behavior untouched.

import { tildePath } from "./text.ts";
import { formatRowLine } from "./theme.ts";

export type ReadSkinEntry = {
  id: string;
  path: string;
  pending: boolean;
  error: boolean;
};
export interface ReadGroupSkinDeps {
  enabled: () => boolean;
  theme: () => unknown;
  active?: () => boolean;
}

export function paintReadGroupLines(theme: unknown, width: number, entries: readonly ReadSkinEntry[]): string[] {
  if (entries.length === 0) return [];
  const anyPending = entries.some((e) => e.pending === true);
  if (entries.length === 1) {
    const only = entries[0];
    if (!only) return [];
    return [
      formatRowLine(theme, width, {
        body: `Read ${only.path}`,
        live: anyPending,
        mark: anyPending ? undefined : "●",
        error: only.error,
      }),
    ];
  }
  const lines = [
    formatRowLine(theme, width, {
      body: `Read ${entries.length} files`,
      live: anyPending,
      mark: anyPending ? undefined : "●",
    }),
  ];
  entries.forEach((entry, idx) => {
    lines.push(
      formatRowLine(theme, width, {
        body: entry.path,
        tree: idx === entries.length - 1 ? "last" : "mid",
        indent: true,
        live: false,
        error: entry.error,
      }),
    );
  });
  return lines;
}

// Exported for verification; the five-method combination is unique to
// ReadToolGroupComponent (ToolExecutionComponent has updateArgs/updateResult
// plus seal, never removeEntry+attachUsage).
export function isReadGroupLike(child: unknown): boolean {
  if (typeof child !== "object" || child === null) return false;
  const c = child as Record<string, unknown>;
  return (
    typeof c["updateArgs"] === "function" &&
    typeof c["updateResult"] === "function" &&
    typeof c["removeEntry"] === "function" &&
    typeof c["attachUsage"] === "function" &&
    typeof c["render"] === "function"
  );
}

let skinned = new WeakSet<object>();
let installed = false;

function entryPathOf(args: unknown): string {
  if (typeof args === "object" && args !== null) {
    const fields = args as Record<string, unknown>;
    const raw = fields["path"] ?? fields["file_path"] ?? "file";
    return tildePath(String(raw ?? "file"));
  }
  return tildePath("file");
}

function resultIsError(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as Record<string, unknown>)["isError"] === true;
}

function skinReadGroup(child: object, deps: ReadGroupSkinDeps): void {
  if (skinned.has(child)) return;
  const c = child as Record<string, unknown>;
  if (
    typeof c["render"] !== "function" ||
    typeof c["updateArgs"] !== "function" ||
    typeof c["updateResult"] !== "function" ||
    typeof c["removeEntry"] !== "function"
  ) {
    return;
  }
  const origRender = c["render"] as (width: number) => readonly string[];
  const origUpdateArgs = c["updateArgs"] as (...args: unknown[]) => unknown;
  const origUpdateResult = c["updateResult"] as (...args: unknown[]) => unknown;
  const origRemoveEntry = c["removeEntry"] as (...args: unknown[]) => unknown;
  const entries = new Map<string, ReadSkinEntry>();
  try {
    (c as Record<string, unknown>)["updateArgs"] = function (args: unknown, id: unknown, ...rest: unknown[]) {
      try {
        if (typeof id === "string" && id.length > 0) {
          const prev = entries.get(id);
          entries.set(id, {
            id,
            path: entryPathOf(args),
            pending: prev?.pending ?? true,
            error: prev?.error ?? false,
          });
        }
      } catch {
        // Entry tracking is display-only; never break the native update.
      }
      return origUpdateArgs.apply(child, [args, id, ...rest]);
    };
    (c as Record<string, unknown>)["updateResult"] = function (
      result: unknown,
      isPartial: unknown,
      id: unknown,
      ...rest: unknown[]
    ) {
      try {
        if (typeof id === "string" && id.length > 0) {
          const prev = entries.get(id);
          if (prev) {
            prev.pending = isPartial === true ? prev.pending : false;
            prev.error = resultIsError(result);
          }
        }
      } catch {
        // Display-only; fall through to native.
      }
      return origUpdateResult.apply(child, [result, isPartial, id, ...rest]);
    };
    (c as Record<string, unknown>)["removeEntry"] = function (id: unknown, ...rest: unknown[]) {
      try {
        if (typeof id === "string") entries.delete(id);
      } catch {
        // Display-only.
      }
      return origRemoveEntry.apply(child, [id, ...rest]);
    };
    (c as Record<string, unknown>)["render"] = function (width: number): readonly string[] {
      if (!deps.enabled()) return origRender.apply(child, [width]);
      let native: readonly string[];
      try {
        native = origRender.apply(child, [width]);
      } catch {
        return paintReadGroupLines(deps.theme(), width, [...entries.values()]);
      }
      if (native.length === 0) return native;
      if (entries.size === 0) return native;
      return paintReadGroupLines(deps.theme(), width, [...entries.values()]);
    };
  } catch {
    // Non-writable method on this instance: best-effort restore so a
    // half-skinned component keeps native behavior, then leave it alone.
    for (const [key, orig] of [
      ["render", origRender],
      ["updateArgs", origUpdateArgs],
      ["updateResult", origUpdateResult],
      ["removeEntry", origRemoveEntry],
    ] as const) {
      try {
        (c as Record<string, unknown>)[key] = orig;
      } catch {
        // Non-writable; native method already intact.
      }
    }
    return;
  }
  skinned.add(child);
}

export function installReadGroupSkin(
  ContainerCtor: { prototype: { addChild: (...args: unknown[]) => unknown } },
  deps: ReadGroupSkinDeps,
): () => void {
  if (installed) return () => {};
  const prototype = ContainerCtor?.prototype;
  const addChild = prototype?.addChild;
  if (typeof addChild !== "function") return () => {};
  const patchedAddChild = function (this: unknown, ...args: unknown[]): unknown {
    if (deps.active?.() === false) return addChild.apply(this, args);
    for (const arg of args) {
      try {
        if (isReadGroupLike(arg)) skinReadGroup(arg as object, deps);
      } catch {
        // One bad child must not break the container.
      }
    }
    return addChild.apply(this, args);
  };
  try {
    prototype.addChild = patchedAddChild;
  } catch {
    return () => {};
  }
  installed = true;
  return () => {
    try {
      if (prototype.addChild === patchedAddChild) prototype.addChild = addChild;
    } catch {
      // Another extension may own the current hook; never overwrite it.
    }
    installed = false;
    skinned = new WeakSet<object>();
  };
}
