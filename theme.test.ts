import { afterEach, describe, expect, mock, test } from "bun:test";

/*
 * Header opacity contract: rows marked as headers paint at the `headerOpacity` setting, detail and
 * body rows at `opacity`, so a card's own header reads above its detail rows.
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

const { formatRowLine, rowRestOpacity } = await import("./core/theme.ts");
const { applyOverlay, DEFAULT_CONFIG, setPluginConfigForTest } = await import("./core/config.ts");

const theme = { fg: (_token: string, text: string) => text } as unknown;
/** Last foreground SGR sequence of a row: the body paint, after the prefix paint. */
const sgrTail = (line: string): string | undefined => [...line.matchAll(/\x1b\[38;2;\d+;\d+;\d+m/g)].at(-1)?.[0];
const headerRow = (opacity: number, headerOpacity: number): string | undefined => {
  setPluginConfigForTest({ ...DEFAULT_CONFIG, opacity, headerOpacity });
  return sgrTail(formatRowLine(theme, 80, { body: "Header", header: true }));
};
const detailRow = (opacity: number, headerOpacity = DEFAULT_CONFIG.headerOpacity): string | undefined => {
  setPluginConfigForTest({ ...DEFAULT_CONFIG, opacity, headerOpacity });
  return sgrTail(formatRowLine(theme, 80, { body: "Detail" }));
};

afterEach(() => setPluginConfigForTest(null));

describe("headerOpacity setting", () => {
  test("defaults to 0.9", () => {
    expect(DEFAULT_CONFIG.headerOpacity).toBe(0.9);
  });

  test("headers paint at headerOpacity and detail rows at opacity", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, opacity: 0.5, headerOpacity: 0.9 });
    expect(rowRestOpacity(true)).toBe(0.9);
    expect(rowRestOpacity(false)).toBe(0.5);

    const header = sgrTail(formatRowLine(theme, 80, { body: "Header", header: true }));
    const detail = sgrTail(formatRowLine(theme, 80, { body: "Detail" }));
    expect(header).toBeDefined();
    expect(header).not.toBe(detail);
  });

  test("the setting drives the paint, not a fixed offset", () => {
    // Same value as opacity: header and detail paint identically.
    expect(headerRow(0.5, 0.5)).toBe(detailRow(0.5, 0.5));
    // Raising it brightens the header only.
    expect(headerRow(0.5, 1)).not.toBe(headerRow(0.5, 0.5));
  });

  test("accepts valid values, clamps bounds, and ignores malformed ones", () => {
    expect(applyOverlay(DEFAULT_CONFIG, { headerOpacity: 0.6 }).headerOpacity).toBe(0.6);
    expect(applyOverlay(DEFAULT_CONFIG, { headerOpacity: 5 }).headerOpacity).toBe(1);
    expect(applyOverlay(DEFAULT_CONFIG, { headerOpacity: -1 }).headerOpacity).toBe(0);
    for (const bad of ["0.9", Number.NaN, null, true]) {
      expect(applyOverlay(DEFAULT_CONFIG, { headerOpacity: bad }).headerOpacity).toBe(0.9);
    }
  });

  test("non-header rows still track opacity", () => {
    expect(detailRow(0.25)).not.toBe(detailRow(0.9));
  });
});
