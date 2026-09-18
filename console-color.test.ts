import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG, setPluginConfigForTest } from "./core/config.ts";
import { detailProfile } from "./core/density.ts";

class MockContainer {
  children: Array<{ render?: (width: number) => readonly string[] }> = [];
  addChild(child: { render?: (width: number) => readonly string[] }) {
    this.children.push(child);
  }
}

mock.module("@oh-my-pi/pi-tui", () => ({
  Container: MockContainer,
  visibleWidth: (s: string) => Bun.stripANSI(s).length,
  padding: (w: number) => " ".repeat(Math.max(0, w)),
  sliceByColumn: (s: string, start: number, len: number) => s.slice(start, start + len),
  truncateToWidth: (s: string, w: number) => s.slice(0, w),
}));

const { colorizeConsoleLine } = await import("./cards/card-primitives.ts");
const { GroupedToolManager } = await import("./cards/grouped-tool-card.ts");
const { renderEvalCard } = await import("./cards/eval-card.ts");

const SUCCESS = "38;2;63;185;80";
const ERROR = "38;2;248;81;73";
const ACCENT = "38;2;0;180;216";

const theme = {
  getColorHex: (token: string) => {
    switch (token) {
      case "success":
        return "#3fb950";
      case "error":
        return "#f85149";
      case "accent":
        return "#00b4d8";
      case "dim":
        return "#787878";
      default:
        return "#b4b4b4";
    }
  },
};

function renderRaw(card: unknown, width = 120): string[] {
  const host = card as {
    render?: (width: number) => readonly string[];
    children?: Array<{ render?: (width: number) => readonly string[] }>;
  };
  return [...(host.render?.(width) ?? host.children?.[0]?.render?.(width) ?? [])];
}

afterEach(() => setPluginConfigForTest(null));

describe("colorizeConsoleLine", () => {
  test("paints unified diff adds, deletes, and hunks", () => {
    const add = "+    const { ctx, widgets, notifications } = createMockCtx();";
    const del = "-    const { ctx, widgets } = createMockCtx();";
    const hunk = '@@ -128,7 +128,7 @@ describe("runPluginDemo", () => {';
    expect(colorizeConsoleLine(theme, add)).toContain(SUCCESS);
    expect(colorizeConsoleLine(theme, del)).toContain(ERROR);
    expect(colorizeConsoleLine(theme, hunk)).toContain(ACCENT);
    expect(Bun.stripANSI(colorizeConsoleLine(theme, add))).toBe(add);
    expect(Bun.stripANSI(colorizeConsoleLine(theme, del))).toBe(del);
    expect(Bun.stripANSI(colorizeConsoleLine(theme, hunk))).toBe(hunk);
  });

  test("paints git diffstat bars and insertion/deletion counts", () => {
    const stat = "      w/demo-showcase.test.ts | 10 +++++++++-";
    const summary = "      2 files changed, 47 insertions(+), 21 deletions(-)";
    const paintedStat = colorizeConsoleLine(theme, stat);
    const paintedSummary = colorizeConsoleLine(theme, summary);
    expect(paintedStat).toContain(SUCCESS);
    expect(paintedStat).toContain(ERROR);
    expect(Bun.stripANSI(paintedStat)).toBe(stat);
    expect(paintedSummary).toContain(SUCCESS);
    expect(paintedSummary).toContain(ERROR);
    expect(Bun.stripANSI(paintedSummary)).toBe(summary);
  });

  test("paints test pass counts and nonzero failures, not 0 fail", () => {
    const pass = "       118 pass";
    const fail = "       1 fail";
    const zero = "       0 fail";
    expect(colorizeConsoleLine(theme, pass)).toContain(SUCCESS);
    expect(colorizeConsoleLine(theme, fail)).toContain(ERROR);
    expect(colorizeConsoleLine(theme, zero)).toBe(zero);
    expect(Bun.stripANSI(colorizeConsoleLine(theme, pass))).toBe(pass);
  });

  test("leaves existing ANSI and non-console source lines alone", () => {
    const ansi = "\x1b[32m✔ pass\x1b[0m \x1b[31m✖ fail\x1b[0m";
    const source = "const x = a | b + c";
    const fileHeader = "+++ b/foo.ts";
    const plusPlus = "--- Changes ---";
    expect(colorizeConsoleLine(theme, ansi)).toBe(ansi);
    expect(colorizeConsoleLine(theme, source)).toBe(source);
    expect(colorizeConsoleLine(theme, fileHeader)).toBe(fileHeader);
    expect(colorizeConsoleLine(theme, plusPlus)).toBe(plusPlus);
  });
});

describe("bash grouped details use console coloring", () => {
  test("bash rows color diffs; read rows do not", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, opacity: 1 });
    const groups = new GroupedToolManager({
      rowIsLive: () => false,
      activityLabel: () => "Running tests",
      activityRunId: () => "console-color",
      activityStartedAt: () => 0,
    });
    const profile = detailProfile({});
    const card = groups.renderToolVisual(theme, "bash:git diff", {
      body: "$ git diff",
      live: false,
      error: false,
      detail: profile,
      details: ["+ bash added", "- bash removed"],
    });
    groups.renderToolVisual(theme, "read:a.ts", {
      body: "Read a.ts",
      live: false,
      error: false,
      detail: profile,
      details: ["+ read added"],
    });
    const lines = renderRaw(card);
    const bashAdd = lines.find((line) => Bun.stripANSI(line).includes("+ bash added"));
    const bashDel = lines.find((line) => Bun.stripANSI(line).includes("- bash removed"));
    const readAdd = lines.find((line) => Bun.stripANSI(line).includes("+ read added"));
    expect(bashAdd).toContain(SUCCESS);
    expect(bashDel).toContain(ERROR);
    expect(readAdd).toBeDefined();
    expect(readAdd).not.toContain(SUCCESS);
  });
});

describe("eval stdout uses console coloring", () => {
  test("eval output paints diff additions", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, opacity: 1 });
    const result = { content: [{ type: "text", text: "+ added\n118 pass" }] };
    const lines = renderRaw(renderEvalCard(theme, { language: "js", code: "1" }, result, {}, false));
    const add = lines.find((line) => Bun.stripANSI(line).includes("+ added"));
    const pass = lines.find((line) => Bun.stripANSI(line).includes("118 pass"));
    expect(add).toContain(SUCCESS);
    expect(pass).toContain(SUCCESS);
  });
});
