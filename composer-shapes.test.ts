import { describe, expect, mock, test } from "bun:test";

/*
 * Composer shape tests. composer-shapes.ts has no local dependencies; its
 * three external imports are mocked here so the real module (including the
 * real Bun.stripANSI paths) runs under `bun test` with no node_modules:
 *
 * - @oh-my-pi/pi-tui: faithful ANSI-aware text helpers. They must preserve
 *   ANSI sequences (the implementation re-wraps/truncates colored chrome),
 *   so naive strip-then-slice fakes would invalidate the color assertions.
 * - theme.fg: distinct magenta so host theme colors are distinguishable from
 *   the simulated green frame color below.
 * - CustomEditor: minimal base class exposing the hooks MinimalPromptEditor
 *   actually uses (getBorderStyle, borderColor, render).
 */

// The module under test is imported dynamically below (with a reason comment
// there) because mock.module() must run before the module loads; a static
// import would hoist above the mocks and defeat them.

// Simulated user theme: borderColor renders green (the reported bug was a
// "grayscale" composer still showing green), accent is cyan.
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[39m";

const ANSI_PART = String.raw`\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)`;

interface AnsiToken {
  ansi: boolean;
  text: string;
}

interface TestComposerBox {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
}

interface TestTopBorder {
  content: string;
  width: number;
}

interface TestChromeContext {
  width: number;
  paddingX: number;
  borderColor: (value: string) => string;
  accentColor: (value: string) => string;
  surfaceColor: (value: string) => string;
  box: TestComposerBox;
  topBorder?: TestTopBorder;
}

interface TestRowContext extends TestChromeContext {
  text: string;
  pad: string;
  gutter: string;
  isLastRow: boolean;
  cursorOverflow: number;
  imeSafeCursorTail: boolean;
  scrollbarThumb: boolean;
}

interface TestComposerStyle {
  id: string;
  sideBorders: boolean;
  verticalChrome: number;
  defaultPromptGutter: string | undefined;
  renderTop: (ctx: TestChromeContext) => string | undefined;
  renderRow: (ctx: TestRowContext) => string[];
  renderBottom: (ctx: TestChromeContext) => string | undefined;
}

interface TestComposerShape {
  label: string;
  description: string;
  style: TestComposerStyle;
}

interface TestContextUsage {
  percent: number;
  contextWindow: number;
}

interface TestPlanStatus {
  enabled: boolean;
  paused: boolean;
}

interface FakeEditorTheme {
  symbols: { boxRound: TestComposerBox };
  __borderStyle: string;
  __borderColor: (value: string) => string;
  __inner: string[];
}

interface ComposerModuleUnderTest {
  MINIMAL_COMPOSER_STYLE: {
    bottomDock: string;
    topDock: string;
    grayscaleBottomDock: string;
    grayscaleTopDock: string;
  };
  MinimalPromptEditor: new (
    tui: unknown,
    theme: FakeEditorTheme,
    keybindings: unknown,
  ) => { render: (width: number) => string[] };
  registerMinimalComposerShapes: (pi: {
    registerComposerShape: (shape: TestComposerShape) => void;
  }) => void;
  updateMinimalPromptEditorProviders: (
    getContextUsage: () => TestContextUsage | undefined,
    getPlanStatus: () => TestPlanStatus | undefined,
  ) => void;
}

function tokenize(value: string): AnsiToken[] {
  const tokens: AnsiToken[] = [];
  const re = new RegExp(ANSI_PART, "g");
  let last = 0;
  for (let match = re.exec(value); match !== null; match = re.exec(value)) {
    if (match.index > last) {
      for (const ch of value.slice(last, match.index)) tokens.push({ ansi: false, text: ch });
    }
    tokens.push({ ansi: true, text: match[0] });
    last = match.index + match[0].length;
  }
  for (const ch of value.slice(last)) tokens.push({ ansi: false, text: ch });
  return tokens;
}

const mockVisibleWidth = (value: string): number =>
  tokenize(value).filter((token) => !token.ansi).length;

const mockPadding = (width: number): string => " ".repeat(Math.max(0, width));

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

function mockSliceByColumn(line: string, startCol: number, length: number): string {
  const out: string[] = [];
  let visible = 0;
  const end = startCol + length;
  for (const token of tokenize(line)) {
    if (token.ansi) {
      if (visible >= startCol && visible < end) out.push(token.text);
      continue;
    }
    if (visible >= startCol && visible < end) out.push(token.text);
    visible += 1;
  }
  return out.join("");
}

class MockContainer {
  children: Array<{ render?: (width: number) => readonly string[] }> = [];
  addChild(child: { render?: (width: number) => readonly string[] }) {
    this.children.push(child);
  }
}

mock.module("@oh-my-pi/pi-tui", () => ({
  Container: MockContainer,
  padding: mockPadding,
  sliceByColumn: mockSliceByColumn,
  truncateToWidth: mockTruncateToWidth,
  visibleWidth: mockVisibleWidth,
}));

mock.module("@oh-my-pi/pi-coding-agent/modes/theme/theme", () => ({
  theme: {
    fg: (_color: string, text: string): string => `${MAGENTA}${text}${RESET}`,
  },
}));

class FakeEditor {
  borderColor: (value: string) => string;
  private styleId: string;
  private inner: string[];

  constructor(_tui: unknown, theme: FakeEditorTheme, _keybindings: unknown) {
    this.styleId = theme.__borderStyle;
    this.borderColor = theme.__borderColor;
    this.inner = [...theme.__inner];
  }

  getBorderStyle(): string {
    return this.styleId;
  }

  render(_width: number): string[] {
    return [...this.inner];
  }
}

mock.module("@oh-my-pi/pi-coding-agent/modes/components/custom-editor", () => ({
  CustomEditor: FakeEditor,
}));

// Dynamic import: mock.module() above must execute before composer-shapes.ts
// loads, so a hoisted static import cannot work here.
const composer: ComposerModuleUnderTest = await import("./composer-shapes.ts");

const BOX: TestComposerBox = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
};

function makeChromeContext(topContent: string): TestChromeContext {
  return {
    width: 80,
    paddingX: 0,
    borderColor: (value: string): string => `${GREEN}${value}${RESET}`,
    accentColor: (value: string): string => `${CYAN}${value}${RESET}`,
    surfaceColor: (value: string): string => value,
    box: BOX,
    topBorder: { content: topContent, width: mockVisibleWidth(topContent) },
  };
}

function makeRowContext(gutter: string): TestRowContext {
  return {
    ...makeChromeContext(""),
    text: "hello",
    pad: "  ",
    gutter,
    isLastRow: true,
    cursorOverflow: 0,
    imeSafeCursorTail: false,
    scrollbarThumb: false,
  };
}

function makeEditorTheme(styleId: string, inner: string[]): FakeEditorTheme {
  return {
    symbols: { boxRound: BOX },
    __borderStyle: styleId,
    __borderColor: (value: string): string => `${GREEN}${value}${RESET}`,
    __inner: inner,
  };
}

const registered: TestComposerShape[] = [];
composer.registerMinimalComposerShapes({
  registerComposerShape: (shape: TestComposerShape): void => {
    registered.push(shape);
  },
});

function styleById(id: string): TestComposerStyle {
  const found = registered.find((shape) => shape.style.id === id)?.style;
  if (!found) throw new Error(`composer style not registered: ${id}`);
  return found;
}

const bottomDock = (): TestComposerStyle => styleById(composer.MINIMAL_COMPOSER_STYLE.bottomDock);
const topDock = (): TestComposerStyle => styleById(composer.MINIMAL_COMPOSER_STYLE.topDock);
const grayscaleBottomDock = (): TestComposerStyle =>
  styleById(composer.MINIMAL_COMPOSER_STYLE.grayscaleBottomDock);
const grayscaleTopDock = (): TestComposerStyle =>
  styleById(composer.MINIMAL_COMPOSER_STYLE.grayscaleTopDock);

const STATUS = "Opus ⌂ myproj ⎇ main 🗺 Plan";

function sgrParams(value: string): string[] {
  return Array.from(value.matchAll(/\x1b\[([0-9;]*)m/g), (match) => match[1] ?? "");
}

/** Every color sequence must be an equal-RGB gray; bare resets pass through. */
function expectGrayscaleOnly(value: string): void {
  const params = sgrParams(value);
  expect(params.length).toBeGreaterThan(0);
  for (const param of params) {
    if (param === "" || param === "0" || param === "39" || param === "49") continue;
    const rgb = /^(?:38|48);2;(\d+);(\d+);(\d+)$/.exec(param);
    if (!rgb) throw new Error(`non-grayscale SGR sequence: \\x1b[${param}m`);
    const [, r, g, b] = rgb;
    expect(r).toBe(g);
    expect(g).toBe(b);
  }
}

function expectNoThemeColors(value: string): void {
  expect(value).not.toContain(GREEN);
  expect(value).not.toContain(CYAN);
  expect(value).not.toContain(MAGENTA);
}
const stripAnsi = (value: string): string => value.replace(new RegExp(ANSI_PART, "g"), "");

/** Plain-text frame contract: corners, width, padding, and content order. */
function expectChromeLayout(line: string, width: number, expectedInner: string): void {
  const plain = stripAnsi(line);
  expect(mockVisibleWidth(line)).toBe(width);
  expect(plain.startsWith(BOX.topLeft) || plain.startsWith(BOX.bottomLeft)).toBe(true);
  expect(plain.endsWith(BOX.topRight) || plain.endsWith(BOX.bottomRight)).toBe(true);
  // One-cell interior padding on both sides of the content.
  expect(plain[1]).toBe(" ");
  expect(plain[plain.length - 2]).toBe(" ");
  // Visible content matches the expected inner text between the padding.
  expect(plain.slice(2, -2)).toBe(expectedInner);
  // Anchored order: project before Git branch, mode pinned at the right.
  const project = plain.indexOf("myproj");
  const branch = plain.indexOf("main");
  const mode = plain.indexOf("Plan");
  if (project >= 0 && branch >= 0) expect(project).toBeLessThan(branch);
  if (mode >= 0) expect(plain.slice(mode)).toBe(plain.slice(mode).trimStart());
}


const resetProviders = (): void => {
  composer.updateMinimalPromptEditorProviders(
    () => undefined,
    () => undefined,
  );
};

describe("composer shape registration", () => {
  test("registers the two colorful and two grayscale composers", () => {
    expect(registered.map((shape) => shape.style.id)).toEqual([
      composer.MINIMAL_COMPOSER_STYLE.bottomDock,
      composer.MINIMAL_COMPOSER_STYLE.topDock,
      composer.MINIMAL_COMPOSER_STYLE.grayscaleBottomDock,
      composer.MINIMAL_COMPOSER_STYLE.grayscaleTopDock,
    ]);
  });

  test("grayscale ids are distinct and labelled as grayscale", () => {
    const colorful = new Set([
      composer.MINIMAL_COMPOSER_STYLE.bottomDock,
      composer.MINIMAL_COMPOSER_STYLE.topDock,
    ]);
    for (const shape of registered) {
      const isGrayscale =
        shape.style.id === composer.MINIMAL_COMPOSER_STYLE.grayscaleBottomDock ||
        shape.style.id === composer.MINIMAL_COMPOSER_STYLE.grayscaleTopDock;
      expect(colorful.has(shape.style.id)).toBe(!isGrayscale);
      expect(shape.label.includes("Grayscale")).toBe(isGrayscale);
    }
  });

  test("all four shapes share the same frame contract", () => {
    for (const shape of registered) {
      expect(shape.style.sideBorders).toBe(false);
      expect(shape.style.verticalChrome).toBe(2);
      expect(shape.style.defaultPromptGutter).toBe("❯ ");
      expect(typeof shape.style.renderTop).toBe("function");
      expect(typeof shape.style.renderRow).toBe("function");
      expect(typeof shape.style.renderBottom).toBe("function");
    }
  });
});

describe("colorful docks preserve theme colors", () => {
  test("top dock keeps project and frame colors", () => {
    resetProviders();
    const line = topDock().renderTop(makeChromeContext(STATUS));
    expect(line).toContain("myproj");
    expect(line).toContain(MAGENTA);
    expect(line).toContain(GREEN);
  });

  test("bottom dock splits project/Git to the top and mode to the bottom", () => {
    resetProviders();
    const top = bottomDock().renderTop(makeChromeContext(STATUS));
    const bottom = bottomDock().renderBottom(makeChromeContext(STATUS));
    expect(top).toContain("myproj");
    expect(top).not.toContain("Plan");
    expect(bottom).toContain("Plan");
  });

  test("top dock renders the full status on top and a plain rule below", () => {
    composer.updateMinimalPromptEditorProviders(
      () => undefined,
      () => ({ enabled: true, paused: false }),
    );
    try {
      const top = topDock().renderTop(makeChromeContext(STATUS));
      expect(top).toContain("myproj");
      expect(top).toContain("Plan");
      const bottom = topDock().renderBottom(makeChromeContext(STATUS)) ?? "";
      const plain = bottom.replace(new RegExp(ANSI_PART, "g"), "");
      expect(plain).not.toContain("Plan");
      expect(plain).not.toContain("myproj");
    } finally {
      resetProviders();
    }
  });
});

describe("grayscale docks collapse color to equal-RGB gray", () => {
  test("grayscale top dock keeps status text but drops every theme color", () => {
    resetProviders();
    const line = grayscaleTopDock().renderTop(makeChromeContext(STATUS)) ?? "";
    const plain = line.replace(new RegExp(ANSI_PART, "g"), "");
    expect(plain).toContain("myproj");
    expect(line).toContain("38;2;142;142;142");
    expect(line).toContain("38;2;176;176;176");
    expectNoThemeColors(line);
    expectGrayscaleOnly(line);
  });

  test("grayscale bottom dock keeps the split layout without theme colors", () => {
    resetProviders();
    const top = grayscaleBottomDock().renderTop(makeChromeContext(STATUS)) ?? "";
    const bottom = grayscaleBottomDock().renderBottom(makeChromeContext(STATUS)) ?? "";
    expect(top).toContain("myproj");
    expect(top).not.toContain("Plan");
    expect(bottom).toContain("Plan");
    expectNoThemeColors(top);
    expectNoThemeColors(bottom);
    expectGrayscaleOnly(top);
    expectGrayscaleOnly(bottom);
  });

  test("grayscale gutter is neutral gray while the colorful gutter passes through", () => {
    const gutter = `${GREEN}❯ ${RESET}`;
    const colorful = bottomDock().renderRow(makeRowContext(gutter));
    expect(colorful[0]).toContain(GREEN);
    const gray = grayscaleBottomDock().renderRow(makeRowContext(gutter));
    expect(gray[0]).toContain("38;2;206;206;206m❯ ");
    expectNoThemeColors(gray[0] ?? "");
    expectGrayscaleOnly(gray[0] ?? "");
  });

  test("grayscale context gauge keeps its label but loses accent and frame colors", () => {
    composer.updateMinimalPromptEditorProviders(
      () => ({ percent: 50, contextWindow: 200_000 }),
      () => ({ enabled: true, paused: false }),
    );
    try {
      const content = `Opus ▶────────────────────◀ ⌂ myproj ⎇ main 🗺 Plan`;
      const colorful = topDock().renderTop(makeChromeContext(content)) ?? "";
      expect(colorful).toContain(CYAN);
      expect(colorful).toContain("50%/200K");
      const gray = grayscaleTopDock().renderTop(makeChromeContext(content)) ?? "";
      expect(gray).toContain("50%/200K");
      expect(gray).toContain("Plan");
      expectNoThemeColors(gray);
      expectGrayscaleOnly(gray);
    } finally {
      resetProviders();
    }
  });
});

describe("grayscale editor frame", () => {
  const frameInner = (innerWidth: number): string[] => [
    `╭${"─".repeat(innerWidth - 2)}╮`,
    `hello${" ".repeat(innerWidth - 5)}`,
    `╰${"─".repeat(innerWidth - 2)}╯`,
  ];

  test("grayscale style frames the editor in gray instead of the host green", () => {
    const editor = new composer.MinimalPromptEditor(
      {},
      makeEditorTheme(composer.MINIMAL_COMPOSER_STYLE.grayscaleBottomDock, frameInner(36)),
      {},
    );
    const rows = editor.render(40);
    expect(rows).toHaveLength(3);
    expect(rows.join("\n")).toContain("38;2;142;142;142");
    expect(rows.join("\n")).not.toContain(GREEN);
    for (const row of rows) expectGrayscaleOnly(row);
  });

  test("colorful style keeps the host border color and adds no gray", () => {
    const editor = new composer.MinimalPromptEditor(
      {},
      makeEditorTheme(composer.MINIMAL_COMPOSER_STYLE.bottomDock, frameInner(36)),
      {},
    );
    const rows = editor.render(40);
    expect(rows).toHaveLength(3);
    expect(rows.join("\n")).toContain(GREEN);
    expect(rows.join("\n")).not.toContain("38;2;");
  });

  test("unknown border styles fall through to the base editor", () => {
    const inner = ["alpha", "beta"];
    const editor = new composer.MinimalPromptEditor({}, makeEditorTheme("box", inner), {});
    expect(editor.render(40)).toEqual(inner);
  });

  test("narrow widths fall through to the base editor even for grayscale styles", () => {
    const inner = ["alpha", "beta"];
    const editor = new composer.MinimalPromptEditor(
      {},
      makeEditorTheme(composer.MINIMAL_COMPOSER_STYLE.grayscaleTopDock, inner),
      {},
    );
    expect(editor.render(8)).toEqual(inner);
  });
});
describe("composer layout is presented correctly", () => {
  test("top dock chrome fills the full width with padded corners", () => {
    composer.updateMinimalPromptEditorProviders(
      () => undefined,
      () => ({ enabled: true, paused: false }),
    );
    try {
      const width = 80;
      const line = topDock().renderTop(makeChromeContext(STATUS)) ?? "";
      // Full status stays on one visible row: project, Git, and pinned mode.
      const plain = stripAnsi(line);
      expect(plain).toContain("myproj");
      expect(plain).toContain("main");
      expect(plain).toContain("Plan");
      expectChromeLayout(line, width, plain.slice(2, -2));
    } finally {
      resetProviders();
    }
  });

  test("bottom dock splits top title from bottom status at the same width", () => {
    resetProviders();
    const width = 80;
    const top = bottomDock().renderTop(makeChromeContext(STATUS)) ?? "";
    const bottom = bottomDock().renderBottom(makeChromeContext(STATUS)) ?? "";
    const topPlain = stripAnsi(top);
    const bottomPlain = stripAnsi(bottom);
    // Top keeps project/Git right-docked; bottom keeps mode right-pinned.
    expect(topPlain).toContain("myproj");
    expect(topPlain).not.toContain("Plan");
    expect(bottomPlain).toContain("Plan");
    expect(mockVisibleWidth(top)).toBe(width);
    expect(mockVisibleWidth(bottom)).toBe(width);
    // Both rows share the frame: corners outside, one-cell padding inside.
    expect(topPlain.startsWith(BOX.topLeft)).toBe(true);
    expect(topPlain.endsWith(BOX.topRight)).toBe(true);
    expect(bottomPlain.startsWith(BOX.bottomLeft)).toBe(true);
    expect(bottomPlain.endsWith(BOX.bottomRight)).toBe(true);
    expect(topPlain[1]).toBe(" ");
    expect(bottomPlain[1]).toBe(" ");
  });

  test("grayscale variants preserve the exact layout of their colorful twins", () => {
    resetProviders();
    for (const [colorful, gray] of [
      [topDock(), grayscaleTopDock()],
      [bottomDock(), grayscaleBottomDock()],
    ] as const) {
      const topA = colorful.renderTop(makeChromeContext(STATUS)) ?? "";
      const topB = gray.renderTop(makeChromeContext(STATUS)) ?? "";
      const bottomA = colorful.renderBottom(makeChromeContext(STATUS)) ?? "";
      const bottomB = gray.renderBottom(makeChromeContext(STATUS)) ?? "";
      // Same visible text, same widths — only the ANSI colors differ.
      expect(stripAnsi(topB)).toBe(stripAnsi(topA));
      expect(stripAnsi(bottomB)).toBe(stripAnsi(bottomA));
      expect(mockVisibleWidth(topB)).toBe(mockVisibleWidth(topA));
      expect(mockVisibleWidth(bottomB)).toBe(mockVisibleWidth(bottomA));
      expectChromeLayout(topB, 80, stripAnsi(topA).slice(2, -2));
      // Content rows keep gutter, text, and padding order.
      const rowA = colorful.renderRow(makeRowContext("❯ "))[0] ?? "";
      const rowB = gray.renderRow(makeRowContext("❯ "))[0] ?? "";
      expect(stripAnsi(rowB)).toBe(stripAnsi(rowA));
      expect(stripAnsi(rowB)).toBe("❯ hello  ");
    }
  });

  test("editor frame keeps three rows with side borders at the safe width", () => {
    const frameInner = (innerWidth: number): string[] => [
      `╭${"─".repeat(innerWidth - 2)}╮`,
      `hello${" ".repeat(innerWidth - 5)}`,
      `╰${"─".repeat(innerWidth - 2)}╯`,
    ];
    for (const styleId of [
      composer.MINIMAL_COMPOSER_STYLE.bottomDock,
      composer.MINIMAL_COMPOSER_STYLE.grayscaleBottomDock,
    ]) {
      const editor = new composer.MinimalPromptEditor(
        {},
        makeEditorTheme(styleId, frameInner(36)),
        {},
      );
      const rows = editor.render(40);
      expect(rows).toHaveLength(3);
      const plain = rows.map(stripAnsi);
      expect(plain[0]?.startsWith("╭")).toBe(true);
      expect(plain[0]?.endsWith("╮")).toBe(true);
      expect(plain[1]).toContain("hello");
      expect(plain[2]?.startsWith("╰")).toBe(true);
      expect(plain[2]?.endsWith("╯")).toBe(true);
      for (const row of rows) expect(mockVisibleWidth(row)).toBe(40);
    }
  });
});

describe("thinking effort expansion", () => {
  test("bottom dock expands xhi to xhigh in the bottom status rule", () => {
    resetProviders();
    const statusWithEffort = "Opus · 󰪥 xhi ⌂ myproj ⎇ main 🗺 Plan";
    const bottom = bottomDock().renderBottom(makeChromeContext(statusWithEffort)) ?? "";
    const plain = stripAnsi(bottom);
    expect(plain).toContain("xhigh");
    expect(plain).not.toMatch(/\bxhi\b/);
  });

  test("top dock expands xhi to xhigh in the top rule", () => {
    resetProviders();
    const statusWithEffort = "Opus · 󰪥 xhi ⌂ myproj ⎇ main 🗺 Plan";
    const top = topDock().renderTop(makeChromeContext(statusWithEffort)) ?? "";
    const plain = stripAnsi(top);
    expect(plain).toContain("xhigh");
    expect(plain).not.toMatch(/\bxhi\b/);
  });

  test("grayscale docks expand xhi to xhigh without theme colors", () => {
    resetProviders();
    const statusWithEffort = "Opus · ◎ xhi ⌂ myproj ⎇ main 🗺 Plan";
    const bottom = grayscaleBottomDock().renderBottom(makeChromeContext(statusWithEffort)) ?? "";
    const plain = stripAnsi(bottom);
    expect(plain).toContain("◎ xhigh");
    expect(plain).not.toMatch(/\bxhi\b/);
    expectGrayscaleOnly(bottom);
  });

  test("preserves surrounding ANSI escape sequences when expanding xhi", () => {
    resetProviders();
    const statusWithAnsi = `${GREEN}Opus${RESET} · ${MAGENTA}󰪥 xhi${RESET} ⌂ myproj ⎇ main`;
    const bottom = bottomDock().renderBottom(makeChromeContext(statusWithAnsi)) ?? "";
    expect(bottom).toContain(`${MAGENTA}󰪥 xhigh${RESET}`);
  });

  test("expands ASCII bracketed [xhi] to [xhigh]", () => {
    resetProviders();
    const statusAscii = "Opus · [xhi] ⌂ myproj ⎇ main";
    const bottom = bottomDock().renderBottom(makeChromeContext(statusAscii)) ?? "";
    expect(stripAnsi(bottom)).toContain("[xhigh]");
  });

  test("leaves other effort levels and already-expanded xhigh unchanged", () => {
    resetProviders();
    for (const level of ["min", "low", "med", "high", "max", "xhigh"]) {
      const status = `Opus · 󰪥 ${level} ⌂ myproj ⎇ main`;
      const bottom = bottomDock().renderBottom(makeChromeContext(status)) ?? "";
      expect(stripAnsi(bottom)).toContain(`󰪥 ${level}`);
    }
  });

  test("MinimalPromptEditor preserves expanded xhigh in framed chrome", () => {
    resetProviders();
    const inner = (innerWidth: number): string[] => [
      `╭${"─".repeat(innerWidth - 2)}╮`,
      `hello${" ".repeat(innerWidth - 5)}`,
      `╰ Opus · 󰪥 xhigh ${"─".repeat(Math.max(0, innerWidth - 20))}╯`,
    ];
    const editor = new composer.MinimalPromptEditor(
      {},
      makeEditorTheme(composer.MINIMAL_COMPOSER_STYLE.bottomDock, inner(36)),
      {},
    );
    const rows = editor.render(40);
    expect(rows.some((row) => stripAnsi(row).includes("xhigh"))).toBe(true);
  });
});

