import { describe, expect, mock, test } from "bun:test";

mock.module("@oh-my-pi/pi-tui", () => ({
  Container: class {
    children: Array<{ render?: (width: number) => readonly string[] }> = [];
    addChild(child: { render?: (width: number) => readonly string[] }) {
      this.children.push(child);
    }
  },
  visibleWidth: (s: string) => Bun.stripANSI(s).length,
  padding: (w: number) => " ".repeat(Math.max(0, w)),
  sliceByColumn: (s: string, start: number, len: number) => s.slice(start, start + len),
  truncateToWidth: (s: string, w: number) => s.slice(0, w),
  matchesKey: (data: string, key: string) => data === key,
}));

// Dynamic imports: mock.module() above must execute before these modules load.
const { CardRegistry } = await import("./cards/card-registry.ts");
const { GroupedToolManager } = await import("./cards/grouped-tool-card.ts");
const { DEFAULT_CONFIG, isWrappedTool, setPluginConfigForTest, wrapTool, WRAPPED_TOOL_REGISTRY } =
  await import("./core/config.ts");

/*
 * Tools with no dedicated layout — lsp, ast_grep, debug, github, checkpoint, rewind, context_notes,
 * new_context, security_scan, memory_edit, retain, recall, reflect, learn, manage_skill — used to
 * keep host-rendered rows with only their result text rewritten. They are wrapped now, so the plugin
 * owns their mark, width, opacity and row shape like every other card.
 */

const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text, dim: (text: string) => text };

function registryFor(active: () => boolean) {
  return new CardRegistry({
    active,
    groupedTools: new GroupedToolManager({
      rowIsLive: () => false,
      activityLabel: () => "",
      activityRunId: () => "run",
      activityStartedAt: () => 0,
    }),
    parentLabelForCard: () => "",
  });
}

function renderTool(toolName: string, args: unknown, result: unknown, width = 100, options: unknown = {}): string[] {
  const registry = new CardRegistry({
    active: () => true,
    groupedTools: new GroupedToolManager({
      rowIsLive: () => false,
      activityLabel: () => "",
      activityRunId: () => "run",
      activityStartedAt: () => 0,
    }),
    parentLabelForCard: () => "",
  });
  const card = registry.render({
    toolName: toolName as never,
    phase: "result",
    theme,
    args,
    options,
    result,
    resultText: { content: [{ type: "text", text: "" }] },
  });
  const host = card as unknown as { render?: (w: number) => string[]; children: Array<{ render: (w: number) => string[] }> };
  const rows = typeof host.render === "function" ? host.render(width) : host.children[0].render(width);
  return rows.map((row) => Bun.stripANSI(String(row)).trimEnd());
}

const textResult = (body: string) => ({ details: {}, content: [{ type: "text", text: body }] });

describe("tools without a dedicated layout render as plugin cards", () => {
  test("the collapsed summary becomes the header, details sit on the content column", () => {
    try {
      setPluginConfigForTest({ ...DEFAULT_CONFIG, detailLevel: "standard" });
      const rows = renderTool(
        "lsp",
        { action: "references", file: "foo.ts" },
        textResult("src/a.ts:12:7\nsrc/b.ts:3:1"),
      );
      expect(rows[0]?.startsWith("◆ ")).toBe(true);
      expect(rows[0]).toContain("Lsp references");
      expect(rows[0]).toContain("2 files");
      // Detail rows align under the card content column, not the host's layout.
      expect(rows.slice(1).every((row) => row.startsWith("     "))).toBe(true);
      expect(rows.join("\n")).toContain("src/a.ts:12");
    } finally {
      setPluginConfigForTest(null);
    }
  });

  test("the header takes the configured mark, not a fixed glyph", () => {
    try {
      setPluginConfigForTest({ ...DEFAULT_CONFIG, indicator: "dot" });
      const rows = renderTool("retain", {}, textResult("stored"));
      expect(rows[0]?.startsWith("● ")).toBe(true);
      expect(rows.join("\n")).not.toContain("◆");
    } finally {
      setPluginConfigForTest(null);
    }
  });

  test("minimal density keeps one row", () => {
    try {
      setPluginConfigForTest({ ...DEFAULT_CONFIG, detailLevel: "minimal" });
      const rows = renderTool("debug", { action: "attach", target: "pid 4242" }, textResult("attached"));
      expect(rows.length).toBe(1);
      expect(rows[0]).toContain("Debug attach pid 4242");
    } finally {
      setPluginConfigForTest(null);
    }
  });

  test("detail rows stay bounded and announce the remainder", () => {
    try {
      setPluginConfigForTest({ ...DEFAULT_CONFIG, detailLevel: "standard", standardOutputMaxRows: 3 });
      const body = Array.from({ length: 40 }, (_, i) => `hit ${i}`).join("\n");
      const rows = renderTool("ast_grep", { pattern: "renderCall" }, textResult(body));
      const detailRows = rows.slice(1).filter((row) => row.includes("hit "));
      expect(detailRows.length).toBeLessThanOrEqual(3);
      expect(rows.join("\n")).toContain("more lines");
    } finally {
      setPluginConfigForTest(null);
    }
  });

  test("an error result is reported on the card, not hidden", () => {
    try {
      setPluginConfigForTest({ ...DEFAULT_CONFIG, detailLevel: "standard" });
      const rows = renderTool(
        "lsp",
        { action: "references" },
        { isError: true, details: { error: "no language server" }, content: [{ type: "text", text: "no language server" }] },
      );
      expect(rows.join("\n")).toContain("no language server");
    } finally {
      setPluginConfigForTest(null);
    }
  });
});

describe("every newly wrapped tool keeps its native escape hatch", () => {
  const TOOLS = [
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
  ];

  test("each is wrappable by default and native when its native* setting is on", () => {
    try {
      for (const tool of TOOLS) {
        setPluginConfigForTest({ ...DEFAULT_CONFIG });
        expect(isWrappedTool(tool)).toBe(true);
        expect(wrapTool(tool)).toBe(true);

        const key = WRAPPED_TOOL_REGISTRY[tool as keyof typeof WRAPPED_TOOL_REGISTRY].nativeKey;
        setPluginConfigForTest({ ...DEFAULT_CONFIG, [key]: true } as never);
        expect(wrapTool(tool)).toBe(false);
      }
    } finally {
      setPluginConfigForTest(null);
    }
  });
});

describe("a renderer must never hide output", () => {
  // The non-negotiable: when the plugin is off, or a `native<Name>` setting wins, the registry throws
  // so the host restores its own renderer. Returning an empty component instead would blank the row.
  const request = {
    phase: "result",
    theme,
    args: {},
    options: {},
    result: { details: {}, content: [{ type: "text", text: "native" }] },
    resultText: { content: [{ type: "text", text: "" }] },
  } as const;

  test("a disabled plugin throws for dedicated cards and collapsed cards alike", () => {
    try {
      setPluginConfigForTest({ ...DEFAULT_CONFIG });
      for (const toolName of ["write", "edit", "eval", "web_search", "lsp", "retain", "recall"]) {
        const registry = registryFor(() => false);
        expect(() => registry.render({ ...request, toolName: toolName as never }), toolName).toThrow(
          /native rendering required/u,
        );
      }
    } finally {
      setPluginConfigForTest(null);
    }
  });

  test("native<Name> mid-session throws too, so the host takes the row back", () => {
    try {
      setPluginConfigForTest({ ...DEFAULT_CONFIG, nativeLsp: true, nativeWrite: true });
      for (const toolName of ["lsp", "write"]) {
        const registry = registryFor(() => true);
        expect(() => registry.render({ ...request, toolName: toolName as never }), toolName).toThrow(
          /native rendering required/u,
        );
      }
    } finally {
      setPluginConfigForTest(null);
    }
  });
});

describe("MCP tools render through the shared collapsed card", () => {
  test("the collapsed one-liner names the server and tool", () => {
    try {
      setPluginConfigForTest({ ...DEFAULT_CONFIG, detailLevel: "standard" });
      const rows = renderTool("mcp__slack__list_channels" as never, {}, textResult("hello"));
      expect(rows[0]?.startsWith("◆ ")).toBe(true);
      expect(rows[0]).toContain("Slack List Channels");
      expect(rows.join("\n")).toContain("hello");
    } finally {
      setPluginConfigForTest(null);
    }
  });
});

describe("grouped executions always render", () => {
  test("a row whose group is gone paints itself instead of nothing", async () => {
    // A grouped tool normally renders inside its group's lead block. Once the group's state is gone —
    // the map is bounded and evicts old runs, or a replay arrives for a result whose lead this session
    // never saw — the lead-less block used to paint zero rows and the execution vanished from the
    // transcript until a restart rebuilt it from the session log.
    const { GroupedToolManager } = await import("./cards/grouped-tool-card.ts");
    const groups = new GroupedToolManager({
      rowIsLive: () => false,
      activityLabel: () => "Running tests",
      activityRunId: () => "group-gone",
    });
    const card = groups.renderToolVisual(
      null,
      "bash:orphaned",
      { body: "ls empty", live: false, error: false, right: "1.0s", details: ["total 0"] },
      { gid: "evicted-group", label: "Old run" },
    );
    const host = card as unknown as { render?: (w: number) => string[]; children: Array<{ render: (w: number) => string[] }> };
    const rows = typeof host.render === "function" ? host.render(120) : host.children[0].render(120);
    const lines = rows.map((row) => Bun.stripANSI(String(row)).trimEnd());
    expect(lines.join("\n"), "the orphaned row paints its label and output").toContain("ls empty");
    expect(lines.join("\n")).toContain("total 0");
  });

  test("an empty result still gets a body so the card is never a lone label row", async () => {
    const { GroupedToolManager } = await import("./cards/grouped-tool-card.ts");
    const groups = new GroupedToolManager({
      rowIsLive: () => false,
      activityLabel: () => "Running tests",
      activityRunId: () => "empty-result",
    });
    const card = groups.renderToolVisual(null, "bash:quiet", {
      body: "mkdir -p q && ls q",
      live: false,
      error: false,
      right: "1.0s",
      details: [],
    });
    const host = card as unknown as { render?: (w: number) => string[]; children: Array<{ render: (w: number) => string[] }> };
    const rows = typeof host.render === "function" ? host.render(120) : host.children[0].render(120);
    const lines = rows.map((row) => Bun.stripANSI(String(row)).trimEnd());
    expect(lines.length, "label plus a body row").toBeGreaterThan(1);
    expect(lines.join("\n")).toContain("(no output)");
  });

  test("an evicted group is rebuilt, so no execution is stranded on a dead group id", async () => {
    // The group map is bounded. Evicting a group used to leave its fingerprints pointing at a gid that no
    // longer existed: every later render of those calls resolved nothing and painted an empty block,
    // which the transcript elides — the call disappeared from the session and only returned when a
    // restart rebuilt the transcript. Eviction now drops the stale mappings with the group, so a later
    // render re-creates it and the rows are painted again.
    const { GroupedToolManager } = await import("./cards/grouped-tool-card.ts");
    let run = 0;
    const groups = new GroupedToolManager({
      rowIsLive: () => false,
      activityLabel: () => `Run ${run}`,
      activityRunId: () => `run-${run}`,
    });
    const renderCard = (card: unknown): string[] => {
      const host = card as unknown as {
        render?: (w: number) => string[];
        children: Array<{ render: (w: number) => string[] }>;
      };
      const rows = typeof host.render === "function" ? host.render(120) : host.children[0].render(120);
      return rows.map((row) => Bun.stripANSI(String(row)).trimEnd());
    };
    const renderRow = (fp: string, body: string, detail: string) =>
      groups.renderToolVisual(null, fp, { body, live: false, error: false, details: [detail] });

    run = 0;
    renderRow("bash:evicted", "the evicted call", "first output");
    for (let index = 1; index <= 45; index += 1) {
      run = index;
      renderRow(`bash:filler-${index}`, `filler ${index}`, `out ${index}`);
    }

    // The evicted call is rendered again: its group is rebuilt under the current run.
    renderRow("bash:evicted", "the evicted call", "first output");
    // Whichever block leads the rebuilt group paints both rows, so the call is on screen again.
    const groupCard = renderRow("bash:filler-45", "filler 45", "out 45");
    const painted = renderCard(groupCard).join("\n");
    expect(painted, "the evicted call is painted again").toContain("the evicted call");
    expect(painted).toContain("first output");
  });
});
