import { afterEach, describe, expect, mock, test } from "bun:test";

/*
 * The plugin's first contract: a wrapped tool must delegate to the native implementation exactly
 * once, with the exact native `parameters` object and unchanged arguments/results. This iterates
 * `WRAPPED_TOOL_REGISTRY`, so a newly wrapped tool is covered the moment it is added.
 */
mock.module("@oh-my-pi/pi-tui", () => ({
  Container: class {
    children: unknown[] = [];
    addChild(child: unknown) {
      this.children.push(child);
    }
    render() {
      return [];
    }
  },
  visibleWidth: (s: string) => Bun.stripANSI(s).length,
  padding: (w: number) => " ".repeat(Math.max(0, w)),
  sliceByColumn: (s: string, start: number, len: number) => s.slice(start, start + len),
  truncateToWidth: (s: string, w: number) => s.slice(0, w),
  matchesKey: (data: string, key: string) => data === key,
}));

mock.module("@oh-my-pi/pi-coding-agent", () => ({
  CustomEditor: class {},
  theme: { fg: () => "" },
}));

// Dynamic imports: mock.module() above must execute before index.ts loads.
const { default: registerExtension } = await import("./index.ts");
const { DEFAULT_CONFIG, setPluginConfigForTest, WRAPPED_TOOL_REGISTRY } = await import("./core/config.ts");

type Handler = (event: unknown, ctx: unknown) => unknown;
interface ShadowTool {
  name: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<unknown>;
}

function harness(tools: Array<{ name: string; parameters: unknown }>) {
  const handlers = new Map<string, Handler[]>();
  const registered = new Map<string, ShadowTool>();
  const widgets = new Map<string, unknown>();
  const pi = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool: (tool: ShadowTool) => registered.set(tool.name, tool),
    registerCommand: () => {},
    registerShortcut: () => {},
    registerMessageRenderer: () => {},
    registerComposerShape: () => {},
    registerAssistantThinkingRenderer: () => {},
    getAllTools: () => tools,
    sendMessage: () => {},
  };
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: (key: string, factory: unknown) => {
        if (factory) widgets.set(key, factory);
        else widgets.delete(key);
      },
      setEditorComponent: () => {},
      requestRender: () => {},
      notify: () => {},
    },
  };
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of [...(handlers.get(name) ?? [])]) await handler(event, ctx);
  };
  return { pi, registered, emit };
}

afterEach(() => setPluginConfigForTest(null));

describe("every wrapped tool shadows the native tool without changing it", () => {
  test("forwards the exact native parameters and delegates exactly once", async () => {
    const names = Object.keys(WRAPPED_TOOL_REGISTRY);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const parameters = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
      const h = harness([{ name, parameters }]);
      registerExtension(h.pi as never);
      await h.emit("session_start");

      const shadow = h.registered.get(name);
      expect(shadow, `${name} was not wrapped`).toBeDefined();
      // The exact native object, not a copy or a hand-written schema.
      expect(shadow!.parameters).toBe(parameters);

      const seen: unknown[] = [];
      const result = { details: { ok: true }, content: [{ type: "text", text: "native" }] };
      const invokeTool = async (params: unknown) => {
        seen.push(params);
        return result;
      };
      const out = await shadow!.execute("call:1", { q: "x" }, undefined, undefined, { invokeTool });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({ q: "x" });
      expect(out).toBe(result);

      await h.emit("session_shutdown");
    }
  });

  test("native<Name> restores the host tool", async () => {
    for (const [name, definition] of Object.entries(WRAPPED_TOOL_REGISTRY)) {
      setPluginConfigForTest({ ...DEFAULT_CONFIG, [definition.nativeKey]: true } as never);
      const h = harness([{ name, parameters: {} }]);
      registerExtension(h.pi as never);
      await h.emit("session_start");
      expect(h.registered.has(name), `${name} should stay native`).toBe(false);
      await h.emit("session_shutdown");
      setPluginConfigForTest(null);
    }
  });

  test("a native tool without parameters is left alone", async () => {
    const h = harness([{ name: "bash", parameters: undefined }]);
    registerExtension(h.pi as never);
    await h.emit("session_start");
    expect(h.registered.has("bash")).toBe(false);
    await h.emit("session_shutdown");
  });

  test("a delegation failure propagates instead of being swallowed", async () => {
    const h = harness([{ name: "grep", parameters: {} }]);
    registerExtension(h.pi as never);
    await h.emit("session_start");
    const shadow = h.registered.get("grep");
    const invokeTool = async () => {
      throw new Error("native grep unavailable");
    };
    await expect(shadow!.execute("call:1", {}, undefined, undefined, { invokeTool })).rejects.toThrow(
      "native grep unavailable",
    );
    await h.emit("session_shutdown");
  });
});
