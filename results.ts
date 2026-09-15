// Tool-result shape readers: stash, fingerprints, error and duration tails.
// Pure over the result object; owns only the fingerprint memo map.

// No imports: result-shape readers only.

// Merge the stashed full text into existing result details without dropping
// tool-owned keys (async state, per-file results, …).
export function stashFullText(prev: unknown, full: string): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  if (typeof prev === "object" && prev !== null && !Array.isArray(prev)) {
    for (const [key, value] of Object.entries(prev)) merged[key] = value;
  }
  merged.minimalFullText = full;
  return merged;
}

export function toolResultText(result: unknown): string {
  try {
    const r = result as { content?: unknown };
    if (typeof result === "string") return result;
    if (Array.isArray(r?.content)) {
      const item = (r.content as Array<{ type?: string; text?: unknown }>).find(
        (c) => c?.type === "text" && typeof c.text === "string",
      );
      if (item && typeof item.text === "string") return item.text as string;
    }
    return "";
  } catch {
    return "";
  }
}

// Label for grep/glob rows. Native grep sends {path, pattern}; native glob
// sends {path} (live-probed 2026-09-11) — the chain degrades to an unlabeled
// one-liner rather than crashing when a key is absent.
export function argsFingerprint(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const fields = args as Record<string, unknown>;
  const primary =
    fields["command"] ??
    fields["path"] ??
    fields["file_path"] ??
    fields["pattern"] ??
    fields["query"] ??
    fields["code"];
  if (typeof primary === "string" && primary) return primary;
  if (typeof primary === "number" && Number.isFinite(primary)) return String(primary);
  const skip = new Set(["i", "__partialJson"]);
  const parts: string[] = [];
  for (const key of Object.keys(fields).sort()) {
    if (skip.has(key)) continue;
    const v = fields[key];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      const s = String(v);
      parts.push(`${key}=${s.length > 160 ? `${s.slice(0, 160)}#${s.length}` : s}`);
    }
  }
  return parts.join(";");
}

export function toolFpBase(toolName: string, args: unknown): string {
  return `${toolName}:${argsFingerprint(args)}`;
}

export function toolFingerprint(toolName: string, args: unknown): string {
  const base = toolFpBase(toolName, args);
  return fpsByBase.get(base) ?? base;
}

export interface ToolCallIdentity {
  fingerprint: string;
  toolName: string;
  args: unknown;
}

export function identityForToolCall(toolCallId: string): ToolCallIdentity | undefined {
  return identitiesByCallId.get(toolCallId);
}

export function fingerprintForToolCall(toolCallId: string): string | undefined {
  return identityForToolCall(toolCallId)?.fingerprint;
}

export function eventFingerprint(event: unknown): string {
  const e = event as { toolName?: unknown; toolCallId?: unknown; input?: unknown; args?: unknown };
  const name = typeof e.toolName === "string" ? e.toolName : "";
  const args = e.input ?? e.args;
  const base = toolFpBase(name, args);
  const id = typeof e.toolCallId === "string" && e.toolCallId ? e.toolCallId : "";
  const fp = id ? `${base}#${id}` : base;
  fpsByBase.set(base, fp);
  if (id) identitiesByCallId.set(id, { fingerprint: fp, toolName: name, args });
  if (fpsByBase.size > 200) {
    const oldest = fpsByBase.keys().next();
    if (!oldest.done) fpsByBase.delete(oldest.value);
  }
  if (identitiesByCallId.size > 200) {
    const oldest = identitiesByCallId.keys().next();
    if (!oldest.done) identitiesByCallId.delete(oldest.value);
  }
  return fp;
}

export const fpsByBase = new Map<string, string>();
export const identitiesByCallId = new Map<string, ToolCallIdentity>();

export function isToolError(result: unknown, options?: unknown): boolean {
  if (typeof options === "object" && options !== null && "isError" in options) {
    if ((options as { isError: unknown }).isError === true) return true;
  }
  if (typeof result !== "object" || result === null) return false;
  const r = result as { isError?: unknown; details?: unknown };
  if (r.isError === true) return true;
  const d = r.details;
  if (typeof d !== "object" || d === null) return false;
  const fields = d as Record<string, unknown>;
  const raw = fields["exitCode"] ?? fields["exit_code"] ?? fields["code"];
  if (typeof raw === "number" && Number.isFinite(raw) && raw !== 0) return true;
  return false;
}

export function durationSuffix(result: unknown): string {
  try {
    const r = result as { details?: unknown };
    const d = r?.details as Record<string, unknown> | undefined;
    if (!d || typeof d !== "object") return "";
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === "number" && Number.isFinite(v) && /ms|milli|duration|wall|elapsed/i.test(k)) {
        if (/sec/i.test(k) && !/ms/i.test(k)) return ` (${v.toFixed(1)}s)`;
        return ` (${(v / 1000).toFixed(1)}s)`;
      }
    }
    return "";
  } catch {
    return "";
  }
}
