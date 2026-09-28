import { describe, expect, mock, test } from "bun:test";

/*
 * Inline status-row tests: the segment has to land on the host's working/idle row immediately before
 * the right-docked tok/s readout, keep that row's width, and leave the host's own render restorable.
 *
 * pi-tui is mocked before the module loads, mirroring todos-header.test.ts, with ANSI-aware width
 * helpers: the row is painted, so a naive `slice` would cut it at the first color sequence.
 */
const ANSI_PART = String.raw`\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b\u009c]*(?:\x07|\x1b\\|\u009c)|\x1b[ -/]*[0-~]?`;

interface AnsiToken {
  ansi: boolean;
  text: string;
}

function tokenize(value: string): AnsiToken[] {
  const tokens: AnsiToken[] = [];
  const re = new RegExp(ANSI_PART, "g");
  let last = 0;
  for (let match = re.exec(value); match !== null; match = re.exec(value)) {
    if (match.index > last) for (const ch of value.slice(last, match.index)) tokens.push({ ansi: false, text: ch });
    tokens.push({ ansi: true, text: match[0] });
    last = match.index + match[0].length;
  }
  for (const ch of value.slice(last)) tokens.push({ ansi: false, text: ch });
  return tokens;
}

const mockVisibleWidth = (value: string): number => tokenize(value).filter((token) => !token.ansi).length;

function mockTruncateToWidth(text: string, maxWidth: number, ellipsis = ""): string {
  const out: string[] = [];
  let width = 0;
  let truncated = false;
  for (const token of tokenize(text)) {
    if (token.ansi) {
      out.push(token.text);
      continue;
    }
    if (width < maxWidth) {
      out.push(token.text);
      width += 1;
      continue;
    }
    truncated = true;
  }
  if (truncated && ellipsis) out.push(ellipsis);
  return out.join("");
}

mock.module("@oh-my-pi/pi-tui", () => ({
  Container: class {
    children: unknown[] = [];
    addChild(child: unknown) {
      this.children.push(child);
    }
  },
  visibleWidth: mockVisibleWidth,
  padding: (w: number) => " ".repeat(Math.max(0, w)),
  sliceByColumn: (s: string, start: number, len: number) => s.slice(start, start + len),
  truncateToWidth: mockTruncateToWidth,
  matchesKey: (data: string, key: string) => data === key,
}));

mock.module("@oh-my-pi/pi-coding-agent", () => ({
  CustomEditor: class {},
  theme: { fg: (_token: string, text: string) => text },
}));

const { ensureTodoStatusRow, restoreTodoStatusRow, spliceStatusSegment, trailerStart } =
  await import("./surfaces/todo-status-row.ts");

const WIDTH = 80;
const SEGMENT = "◆ Todos 3 open, 1 done — Task Alpha";

/** The host's working row: indicator on the left, tok/s trailer docked right. */
function workingRow(trailer = "tok/s: 12.3 tok/s"): string {
  const left = "◈ Working…";
  return `${left}${" ".repeat(WIDTH - left.length - trailer.length)}${trailer}`;
}

/** The host's idle HUD row: dock padding plus the reading, no left content. */
function idleRow(trailer = "tok/s: 12.3 tok/s"): string {
  return `${" ".repeat(WIDTH - trailer.length)}${trailer}`;
}

interface FakeHost {
  tui: { children: unknown[] };
  statusContainer: {
    render: (width: number) => readonly string[];
    children: unknown[];
    mode?: unknown;
  };
  setHostRows: (rows: readonly string[]) => void;
}

/** Minimal composer runtime the host resolver accepts: a child that owns its mode and composer. */
function fakeHost(): FakeHost {
  let rows: readonly string[] = [];
  const statusContainer: FakeHost["statusContainer"] = {
    children: [],
    render: () => rows,
  };
  const tui = { children: [] as unknown[] };
  const composer = {
    ui: tui,
    setRuntimeChildren(children: readonly unknown[]) {
      tui.children = [children[0], ...children, { setComponent: () => {}, render: () => [] }];
    },
  };
  const mode = { statusContainer, hookWidgetContainerAbove: { children: [] }, attachmentChipsContainer: {}, composer };
  statusContainer.mode = mode;
  // The host mounts its runtime children on the TUI; the resolver walks `tui.children` for the
  // container that owns the mode it renders for.
  composer.setRuntimeChildren([{ children: [] }, statusContainer, {}, {}]);
  return {
    tui,
    statusContainer,
    setHostRows: (next) => {
      rows = next;
    },
  };
}

function deps(segment = SEGMENT) {
  return {
    owns: () => true,
    enabled: () => true,
    segment: (budget: number) => mockTruncateToWidth(segment, budget, ""),
  };
}

describe("status trailer detection", () => {
  test("anchors on the tok/s readout, not on the spaces inside the trailer", () => {
    const row = `${" ".repeat(20)}tok/s: 12.3 tok/s  Plan mode`;
    expect(row.slice(trailerStart(row))).toBe("tok/s: 12.3 tok/s  Plan mode");
  });

  test("falls back to the final run when the row carries no reading", () => {
    const row = "◈ Working…                 Plan mode";
    expect(row.slice(trailerStart(row))).toBe("Plan mode");
    // An all-trailer row (the idle HUD with nothing docked) starts at its first text.
    expect(trailerStart("      12.3 tok/s")).toBe(6);
    expect(trailerStart("        ")).toBe(8);
  });
});

describe("status segment splice", () => {
  test("sits immediately before the trailer and keeps the row width", () => {
    const row = workingRow();
    const spliced = spliceStatusSegment(row, WIDTH, SEGMENT);
    expect(mockVisibleWidth(spliced), "width preserved").toBe(WIDTH);
    expect(Bun.stripANSI(spliced).endsWith("tok/s: 12.3 tok/s"), "trailer stays right-docked").toBe(true);
    expect(Bun.stripANSI(spliced).indexOf(SEGMENT)).toBeLessThan(Bun.stripANSI(spliced).indexOf("tok/s:"));
    expect(Bun.stripANSI(spliced).startsWith("◈ Working…"), "host content kept").toBe(true);
  });

  test("uses the dock padding of an idle row", () => {
    const spliced = spliceStatusSegment(idleRow(), WIDTH, SEGMENT);
    expect(mockVisibleWidth(spliced)).toBe(WIDTH);
    const plain = Bun.stripANSI(spliced);
    expect(plain.trimStart().startsWith(SEGMENT)).toBe(true);
    expect(plain.endsWith("tok/s: 12.3 tok/s")).toBe(true);
  });

  test("shrinks the segment when the host content leaves little room", () => {
    const trailer = "tok/s: 12.3 tok/s";
    const crowded = `${"◈ Working…".padEnd(40, "x")}${" ".repeat(80 - 40 - trailer.length)}${trailer}`;
    const spliced = spliceStatusSegment(crowded, WIDTH, SEGMENT);
    expect(mockVisibleWidth(spliced), "width preserved").toBe(WIDTH);
    expect(Bun.stripANSI(spliced).endsWith(trailer), "trailer stays right-docked").toBe(true);
    expect(Bun.stripANSI(spliced), "segment clipped to the room").not.toContain("Task Alpha");

    // Below a readable width the host's row is handed back untouched.
    const packed = `${"y".repeat(80 - trailer.length - 4)}    ${trailer}`;
    expect(spliceStatusSegment(packed, WIDTH, SEGMENT)).toBe(packed);
  });

  test("an empty segment leaves the row untouched", () => {
    const row = workingRow();
    expect(spliceStatusSegment(row, WIDTH, "")).toBe(row);
  });
});

describe("status row install", () => {
  test("splices the segment into the host's row and adds a row when the host has none", () => {
    const host = fakeHost();
    host.setHostRows([workingRow()]);
    try {
      ensureTodoStatusRow(host.tui, deps());
      const [row] = host.statusContainer.render(WIDTH);
      expect(Bun.stripANSI(row ?? "")).toContain(SEGMENT);
      expect(Bun.stripANSI(row ?? "").endsWith("tok/s: 12.3 tok/s")).toBe(true);

      // No reading yet: the host renders nothing, and the segment still gets its row.
      host.setHostRows([]);
      const idle = host.statusContainer.render(WIDTH);
      expect(idle).toHaveLength(1);
      expect(Bun.stripANSI(idle[0] ?? "").trim()).toBe(SEGMENT);
      expect(mockVisibleWidth(idle[0] ?? "")).toBe(WIDTH);
    } finally {
      restoreTodoStatusRow();
    }
  });

  test("paints once when the host's idle HUD is a blank row plus the reading row", () => {
    // The host's idle stand-in is `["", padding + reading]`; painting both rows would double the
    // summary, once alone in the reserved blank row and once before the reading.
    const host = fakeHost();
    host.setHostRows(["", idleRow()]);
    try {
      ensureTodoStatusRow(host.tui, deps());
      const rows = host.statusContainer.render(WIDTH);
      expect(rows).toHaveLength(2);
      expect(rows[0], "the host's spacer row stays blank").toBe("");
      const painted = rows.map((row) => Bun.stripANSI(row));
      expect(painted.filter((row) => row.includes(SEGMENT))).toHaveLength(1);
      expect(painted[1]?.endsWith("tok/s: 12.3 tok/s")).toBe(true);
    } finally {
      restoreTodoStatusRow();
    }
  });

  test("adds its own row after host blanks that carry no trailer", () => {
    const host = fakeHost();
    host.setHostRows(["", ""]);
    try {
      ensureTodoStatusRow(host.tui, deps());
      const rows = host.statusContainer.render(WIDTH);
      expect(rows).toHaveLength(3);
      expect(rows.slice(0, 2)).toEqual(["", ""]);
      expect(Bun.stripANSI(rows[2] ?? "").trim()).toBe(SEGMENT);
    } finally {
      restoreTodoStatusRow();
    }
  });

  test("without todos the host row is returned untouched", () => {
    const host = fakeHost();
    host.setHostRows([workingRow()]);
    try {
      ensureTodoStatusRow(host.tui, deps(""));
      expect(host.statusContainer.render(WIDTH)).toEqual([workingRow()]);
    } finally {
      restoreTodoStatusRow();
    }
  });

  test("disable and teardown restore the host's own render", () => {
    const host = fakeHost();
    host.setHostRows([workingRow()]);
    const native = host.statusContainer.render;
    ensureTodoStatusRow(host.tui, deps());
    expect(host.statusContainer.render).not.toBe(native);
    expect(Bun.stripANSI(host.statusContainer.render(WIDTH)[0] ?? "")).toContain(SEGMENT);

    restoreTodoStatusRow();
    expect(host.statusContainer.render).toBe(native);
    expect(host.statusContainer.render(WIDTH)).toEqual([workingRow()]);

    // A disabled plugin must not paint the segment even while the wrapper is installed.
    ensureTodoStatusRow(host.tui, { ...deps(), enabled: () => false });
    expect(host.statusContainer.render(WIDTH)).toEqual([workingRow()]);
    restoreTodoStatusRow();
  });
});
