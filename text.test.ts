import { describe, expect, mock, test } from "bun:test";

/*
 * Truncation tests.
 *
 * Mocks pi-tui before importing the module under test, mirroring scrolling-text.test.ts.
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

const { truncatePlain } = await import("./core/text.ts");

describe("truncatePlain", () => {
  test("never splits a surrogate pair and never exceeds the budget", () => {
    // 9 ASCII, then an astral-plane glyph whose cut boundary falls mid-pair at max = 11.
    const text = "abcdefghi\u{1F600}klmnop";
    const offenders: string[] = [];
    for (let max = 1; max <= 16; max += 1) {
      const out = truncatePlain(text, max);
      const width = Bun.stripANSI(out).length;
      if (width > max) offenders.push(`max=${max} produced width ${width}`);
      const body = out.replace(/…$/u, "");
      for (let i = 0; i < body.length; i += 1) {
        const unit = body.charCodeAt(i);
        if (unit < 0xd800 || unit > 0xdbff) continue;
        const next = body.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) offenders.push(`max=${max} left a lone high surrogate at ${i}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("keeps short text untouched and marks only truncated text", () => {
    expect(truncatePlain("short", 20)).toBe("short");
    expect(truncatePlain("abcdef", 3)).toBe("ab…");
  });
});
