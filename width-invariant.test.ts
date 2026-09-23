import { describe, expect, mock, test } from "bun:test";

// Faithful `visibleWidth`: ANSI-stripped, East-Asian-wide aware, zero-width aware. The plugin's row
// math uses the host's native width function, so an ASCII-only stand-in would miss CJK overflow.
function charCells(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0x202c ||
    cp === 0x202e ||
    cp === 0xfeff
  ) {
    return 0;
  }
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

function cellsOf(text: string): number {
  let total = 0;
  for (const ch of Bun.stripANSI(text)) total += charCells(ch.codePointAt(0) ?? 0);
  return total;
}

mock.module("@oh-my-pi/pi-tui", () => ({
  Container: class {
    children: Array<{ render?: (width: number) => readonly string[] }> = [];
    addChild(child: { render?: (width: number) => readonly string[] }) {
      this.children.push(child);
    }
  },
  visibleWidth: cellsOf,
  padding: (w: number) => " ".repeat(Math.max(0, w)),
  sliceByColumn: (s: string, start: number, len: number) => s.slice(start, start + len),
  truncateToWidth: (s: string, w: number) => s.slice(0, w),
  matchesKey: (data: string, key: string) => data === key,
}));

// Dynamic imports: mock.module() above must execute before these modules load.
const { CardRegistry } = await import("./cards/card-registry.ts");
const { GroupedToolManager, renderGroupedToolCard } = await import("./cards/grouped-tool-card.ts");
const { paintReadGroupLines } = await import("./surfaces/read-group.ts");
const { renderDensityTodoHeader } = await import("./surfaces/todos-header.ts");
const { paintAlertLine } = await import("./surfaces/warning-skin.ts");
const { ThinkingWidget } = await import("./surfaces/thinking-widget.ts");
const { DEFAULT_CONFIG, setPluginConfigForTest } = await import("./core/config.ts");
const { installNativeToolCardSkin } = await import("./cards/native-tool-card-skin.ts");
const { eventFingerprint } = await import("./core/results.ts");
const { paintActivityStatus } = await import("./core/activity-tracker.ts");
const { Container: PatchedContainer } = await import("@oh-my-pi/pi-tui");

const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text, dim: (text: string) => text };

/** Content that has broken width math before: wide glyphs, escapes, tabs, unbreakable tokens. */
const HOSTILE = [
  "报告渲染宽度测试内容一二三四五六七八九十",
  "👨‍👩‍👧‍👦🏳️‍🌈🎯👍🏽",
  "e\u0301\u0301combining",
  "\u001b[31mred\u001b[0m\u001b[1;38;5;208m256\u001b[0m",
  "a\tb\tc",
  "x".repeat(300),
  "\u202eRTL\u202c",
  "ctl\u0007\u0008\u000b",
  "→ arrow ◈◉◎○ ◆◇●",
];

const WIDTHS = [20, 24, 40, 60, 80, 120, 200];

/** More lines than any density's row cap, so the "… N more lines" hint rows render too. */
const manyLines = (line: string): string => Array.from({ length: 12 }, () => line).join("\n");

interface Surface {
  name: string;
  render: (width: number, hostile: string) => string[];
}

function rowsOf(container: unknown, width: number): string[] {
  const host = container as { render?: (w: number) => string[]; children?: unknown[] };
  if (typeof host?.render === "function") {
    try {
      return [...(host.render(width) ?? [])];
    } catch {
      // Fall through to the child walk below.
    }
  }
  if (Array.isArray(host?.children)) return host.children.flatMap((child) => rowsOf(child, width));
  return [];
}

const groupedDeps = {
  rowIsLive: () => false,
  activityLabel: () => "working",
  activityRunId: () => "run",
  activityStartedAt: () => 0,
};

/**
 * A grouped tool renders only for its group's lead row, so every grouped surface needs its own
 * manager: sharing one would make all but the first surface an empty (silently vacuous) block.
 */
function registryFor(toolName: string): CardRegistry {
  const groupedTools = new GroupedToolManager(groupedDeps);
  return new CardRegistry({ active: () => true, groupedTools, parentLabelForCard: () => "" });
}

const surfaces: Surface[] = [];
for (const toolName of [
  "bash",
  "read",
  "grep",
  "glob",
  "write",
  "edit",
  "eval",
  "web_search",
  // Tools with no dedicated layout: same row primitives, so the same width contract.
  "lsp",
  "ast_grep",
  "debug",
  "github",
  "checkpoint",
  "rewind",
  "context_notes",
  "new_context",
  "security_scan",
  "memory_edit",
  "retain",
  "recall",
  "reflect",
  "learn",
  "manage_skill",
]) {
  for (const state of ["running", "settled", "error"] as const) {
    // Expanded runs the detail paths — content lines, diffs, output bodies — which is where an
    // unclamped row would come from.
    for (const expanded of [false, true]) {
    surfaces.push({
      name: `${toolName}/${state}${expanded ? "/expanded" : ""}`,
      render: (width, hostile) => {
        const input: Record<string, unknown> =
          toolName === "bash"
            ? { command: hostile, i: "Running a hostile command" }
            : toolName === "read"
              ? { path: hostile, i: "Reading a hostile path" }
              : toolName === "grep"
                ? { pattern: hostile, i: "Searching hostile input" }
                : toolName === "glob"
                  ? { pattern: hostile, i: "Globbing hostile input" }
                  : toolName === "write"
                    ? { path: hostile, content: manyLines(hostile), i: "Writing hostile content" }
                    : toolName === "edit"
                      ? { path: hostile, oldText: hostile, newText: manyLines(hostile), i: "Editing hostile content" }
                      : toolName === "eval"
                        ? { title: hostile, code: manyLines(hostile), i: "Evaluating hostile input" }
                        : { query: hostile, i: "Searching the web with hostile input" };
        const result =
          state === "running"
            ? undefined
            : state === "error"
              ? { isError: true, details: { error: hostile }, content: [{ type: "text", text: hostile }] }
              : {
                  details: {
                    stdout: manyLines(hostile),
                    output: manyLines(hostile),
                    response: { sources: [{ title: hostile, url: `https://example.test/${hostile}` }] },
                  },
                  content: [{ type: "text", text: hostile }],
                };
        return rowsOf(
          registryFor(toolName).render({
            toolName,
            args: input,
            input,
            result,
            resultText: { content: [{ type: "text", text: hostile }] },
            toolCallId: `call:${toolName}`,
            expanded,
            options: { expanded },
            width,
            theme,
            parentLabel: "",
          }),
          width,
        );
      },
    });
    }
  }
}

surfaces.push({
  name: "grouped/bash",
  render: (width, hostile) =>
    rowsOf(
      renderGroupedToolCard({
        theme,
        toolName: "bash",
        args: { command: hostile },
        result: undefined,
        options: { expanded: false },
        fingerprint: "bash:width",
        phase: "call",
        groupedTools: new GroupedToolManager(groupedDeps),
      }),
      width,
    ),
});
surfaces.push({
  name: "read-group",
  render: (width, hostile) =>
    paintReadGroupLines(theme, width, [
      { path: hostile, pending: false, error: false },
      { path: `${hostile}/nested`, pending: true, error: true },
    ]),
});
surfaces.push({
  name: "todos-header/collapsed",
  render: (width, hostile) =>
    renderDensityTodoHeader(
      theme,
      width,
      {
        items: [
          { content: hostile, status: "in_progress" },
          { content: hostile, status: "completed" },
        ],
        open: 1,
        done: 1,
        blocked: 0,
        activeLabel: hostile,
      },
      false,
    ),
});
surfaces.push({
  name: "todos-header/expanded",
  render: (width, hostile) =>
    renderDensityTodoHeader(
      theme,
      width,
      {
        items: Array.from({ length: 6 }, () => ({ content: hostile, status: "pending" })),
        open: 6,
        done: 0,
        blocked: 0,
        activeLabel: "",
      },
      true,
    ),
});
surfaces.push({
  name: "alert",
  render: (width, hostile) =>
    paintAlertLine(theme, width, {
      todos: [{ content: hostile, status: "pending" }],
      attempt: 1,
      maxAttempts: 5,
      render: () => [hostile],
    }),
});

// The native Task/Hub skin repaints host ToolExecutionComponent rows, so its output lands in the
// transcript like any other row producer.
installNativeToolCardSkin(PatchedContainer, {
  enabled: () => true,
  theme: () => theme,
  parentLabel: () => "",
  active: () => true,
});

const NATIVE_FALLBACK = "__native_fallback__";

interface HostToolExecution {
  render: (width: number) => readonly string[];
  updateArgs: (args: unknown, toolCallId: string) => void;
  updateResult: (result: unknown, partial: boolean, toolCallId: string) => void;
  setExecutionStarted: (toolCallId: string) => void;
  setExpanded: (expanded: boolean) => void;
  seal: () => void;
}

function hostToolExecution(native: (width: number) => readonly string[]): HostToolExecution {
  return {
    render: native,
    updateArgs: () => {},
    updateResult: () => {},
    setExecutionStarted: () => {},
    setExpanded: () => {},
    seal: () => {},
  };
}

function nativeSkinSurface(name: string, toolName: "task" | "hub", expanded: boolean): Surface {
  return {
    name,
    render: (width, hostile) => {
      const args =
        toolName === "task"
          ? { name: hostile, prompt: hostile, i: "Delegating hostile work" }
          : { op: "send", to: hostile, message: hostile, i: "Sending hostile work" };
      const result =
        toolName === "task"
          ? {
              details: {
                results: [
                  { agent: hostile, status: "completed", result: hostile, durationMs: 1200 },
                  { agent: `${hostile}b`, status: "failed", result: hostile },
                ],
                totalDurationMs: 2400,
              },
              content: [{ type: "text", text: hostile }],
            }
          : {
              details: { op: "send", to: hostile, delivered: true, message: hostile, preview: hostile },
              content: [{ type: "text", text: hostile }],
            };
      const toolCallId = `native:${toolName}`;
      eventFingerprint({ toolName, toolCallId, input: args });
      const container = new PatchedContainer();
      // A sentinel the skin must replace: if it survives, the skin fell back to native rows and this
      // surface would be checking the harness instead of the plugin.
      const child = hostToolExecution(() => [NATIVE_FALLBACK, `${NATIVE_FALLBACK} ${hostile}`]);
      container.addChild(child);
      child.setExecutionStarted(toolCallId);
      child.updateArgs(args, toolCallId);
      child.updateResult(result, false, toolCallId);
      child.setExpanded(expanded);
      child.seal();
      return rowsOf(container, width);
    },
  };
}

surfaces.push(nativeSkinSurface("native-skin/task", "task", false));
surfaces.push(nativeSkinSurface("native-skin/task/expanded", "task", true));
surfaces.push(nativeSkinSurface("native-skin/hub", "hub", false));
surfaces.push(nativeSkinSurface("native-skin/hub/expanded", "hub", true));

surfaces.push({
  name: "activity-status",
  render: (width, hostile) =>
    rowsOf(
      paintActivityStatus(theme, {
        label: () => `bash ${hostile}`,
        context: () => hostile,
        outcome: () => hostile,
        live: () => true,
        error: () => false,
        fadeKey: "activity:width",
      }),
      width,
    ),
});

const hookAbove = { children: [] as unknown[], render: () => [] as string[] };
const statusContainer: Record<string, unknown> = { setComponent: () => {} };
const composer: Record<string, unknown> = { ui: undefined };
statusContainer["mode"] = { statusContainer, hookWidgetContainerAbove: hookAbove, attachmentChipsContainer: {}, composer };
const tui = { children: [{}, hookAbove, statusContainer, {}], requestRender: () => {} };
composer["ui"] = tui;
surfaces.push({
  name: "thinking-widget",
  render: (width, hostile) => {
    const widget = new ThinkingWidget({ owns: () => true, activityRunId: () => "run" });
    widget.live = true;
    widget.text = hostile;
    return rowsOf(widget.paintThinkingVisual(tui, theme), width);
  },
});

describe("every row-producing surface respects the width it was given", () => {
  test("no row is wider than the render width for hostile content", () => {
    const violations: string[] = [];
    const silent: string[] = [];
    const fellBack: string[] = [];
    let totalRows = 0;
    try {
      for (const detailLevel of ["minimal", "standard", "detailed"] as const) {
        setPluginConfigForTest({ ...DEFAULT_CONFIG, detailLevel });
        for (const width of WIDTHS) {
          for (const surface of surfaces) {
            let surfaceRows = 0;
            for (const hostile of HOSTILE) {
              for (const row of surface.render(width, hostile)) {
                surfaceRows += 1;
                const cells = cellsOf(String(row));
                if (String(row).includes(NATIVE_FALLBACK)) fellBack.push(surface.name);
                if (cells > width) {
                  violations.push(
                    `${surface.name} ${detailLevel} @${width} -> ${cells} cells: ${JSON.stringify(String(row).slice(0, 60))}`,
                  );
                }
              }
            }
            if (width === WIDTHS[0] && detailLevel === "minimal" && surfaceRows === 0) silent.push(surface.name);
            totalRows += surfaceRows;
          }
        }
      }
    } finally {
      setPluginConfigForTest(null);
    }
    // A surface that renders nothing would pass the width check vacuously.
    expect(silent).toEqual([]);
    // Likewise a native-skin surface that fell back to the host's rows.
    expect([...new Set(fellBack)]).toEqual([]);
    expect(totalRows).toBeGreaterThan(5000);
    expect([...new Set(violations)]).toEqual([]);
  });
});

// Guards the sweep itself: an ASCII-only width function would pass every assertion above.
describe("the sweep's width function counts wide glyphs", () => {
  test("CJK and ZWJ emoji count as two cells", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG });
    try {
      expect(cellsOf("报告")).toBe(4);
      expect(cellsOf("🎯")).toBe(2);
      expect(cellsOf("e\u0301")).toBe(1);
      expect(cellsOf("\u001b[31mab\u001b[0m")).toBe(2);
    } finally {
      setPluginConfigForTest(null);
    }
  });
});
