import { afterEach, describe, expect, mock, test } from "bun:test";

/*
 * Every settled card header must take its mark from the `indicator` setting, except the documented
 * exceptions (Task, Hub, web-search, read-group — see the legend in docs/EXAMPLES.md).
 *
 * Mocks pi-tui before importing the modules under test, mirroring scrolling-text.test.ts.
 */
mock.module("@oh-my-pi/pi-tui", () => ({
  Container: class {
    children: unknown[] = [];
    addChild(child: unknown) {
      this.children.push(child);
    }
  },
  visibleWidth: (s: string) => Bun.stripANSI(s).length,
  padding: (w: number) => " ".repeat(Math.max(0, w)),
  sliceByColumn: (s: string, start: number, len: number) => s.slice(start, start + len),
  truncateToWidth: (s: string, w: number) => s.slice(0, w),
  matchesKey: (data: string, key: string) => data === key,
}));

const { renderEvalCard } = await import("./cards/eval-card.ts");
const { renderWriteCard } = await import("./cards/write-card.ts");
const { renderHubGalleryCard, renderTaskGalleryCard, renderWebSearchGalleryCard } = await import(
  "./cards/card-gallery.ts"
);
const { DEFAULT_CONFIG, setPluginConfigForTest } = await import("./core/config.ts");

const theme = { fg: (_token: string, text: string) => text } as unknown;
const text = (value: string) => ({ content: [{ type: "text", text: value }] });

function headerRow(card: unknown): string {
  const host = card as {
    render?: (w: number) => readonly string[];
    children?: Array<{ render?: (w: number) => readonly string[] }>;
  };
  const lines = host.children?.[0]?.render?.(100) ?? host.render?.(100) ?? [];
  return Bun.stripANSI(lines[0] ?? "");
}

function settledHeaders(): Record<string, string> {
  return {
    eval: headerRow(renderEvalCard(theme, { language: "js", code: "1" }, text("2"), {}, false, "eval:1", "")),
    write: headerRow(
      renderWriteCard(theme, { path: "src/a.ts", content: "a" }, text("Wrote src/a.ts"), {}, "write:1", () => ""),
    ),
    web_search: headerRow(renderWebSearchGalleryCard(theme, "success")),
    task: headerRow(renderTaskGalleryCard(theme, "success")),
    hub: headerRow(renderHubGalleryCard(theme, "success")),
  };
}

afterEach(() => setPluginConfigForTest(null));

describe("settled card marks follow the indicator setting", () => {
  const CASES = [
    ["diamond", "◆"],
    ["dot", "●"],
    ["none", " "],
  ] as const;

  test("every settled card header uses the configured mark", () => {
    const wrong: string[] = [];
    for (const [indicator, mark] of CASES) {
      setPluginConfigForTest({ ...DEFAULT_CONFIG, indicator });
      const headers = settledHeaders();
      for (const tool of Object.keys(headers)) {
        const row = headers[tool]!;
        if (!row.startsWith(`${mark} `)) wrong.push(`${tool} @ ${indicator}: ${JSON.stringify(row.slice(0, 24))}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
