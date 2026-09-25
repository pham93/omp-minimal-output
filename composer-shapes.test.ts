import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG, setPluginConfigForTest } from "./core/config.ts";
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
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
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

interface TestWorkingStatus {
  startedAt: number;
}

interface FakeEditorTheme {
  symbols: { boxRound: TestComposerBox };
  __borderStyle: string;
  __borderColor: (value: string) => string;
  __inner: string[];
  __widths: number[];
}

interface ComposerShapesModule {
  MINIMAL_COMPOSER_STYLE: {
    bottomDock: string;
    topDock: string;
    grayscaleBottomDock: string;
    grayscaleTopDock: string;
    belowDock: string;
  };
  registerMinimalComposerShapes: (pi: { registerComposerShape: (shape: TestComposerShape) => void }) => void;
}

interface ComposerEditorModule {
  MinimalPromptEditor: new (
    tui: unknown,
    theme: FakeEditorTheme,
    keybindings: unknown,
  ) => { render: (width: number) => string[] };
  getComposerRefreshIntervalMs: () => number;
  syncComposerRefreshTimer: (tui?: unknown) => void;
  stopComposerRefreshTimer: () => void;
}

interface ComposerStatusModule {
  isCrashDumpText: (text: string) => boolean;
  dockStatusContent: (content: string) => string;
  installStatusRowGuard: (wrapper: unknown) => (() => void) | undefined;
  restoreStatusRowGuard: (wrapper: unknown) => void;
  decorateStatusContent: (content: string, ctx: TestChromeContext, gaugeWidthReduction?: number) => string;
  updateMinimalPromptEditorProviders: (
    getContextUsage: () => TestContextUsage | undefined,
    getPlanStatus: () => TestPlanStatus | undefined,
    getWorkingStatus?: () => TestWorkingStatus | undefined,
    getSessionName?: () => string | undefined,
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

const mockVisibleWidth = (value: string): number => tokenize(value).filter((token) => !token.ansi).length;

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
  matchesKey: (data: string, key: string) => data === key,
}));

class FakeEditor {
  borderColor: (value: string) => string;
  private styleId: string;
  private inner: string[];
  private theme: FakeEditorTheme;

  constructor(_tui: unknown, theme: FakeEditorTheme, _keybindings: unknown) {
    this.styleId = theme.__borderStyle;
    this.borderColor = theme.__borderColor;
    this.inner = [...theme.__inner];
    this.theme = theme;
  }

  getBorderStyle(): string {
    return this.styleId;
  }

  render(width: number): string[] {
    this.theme.__widths.push(width);
    return [...this.inner];
  }
}

mock.module("@oh-my-pi/pi-coding-agent", () => ({
  CustomEditor: FakeEditor,
  theme: {
    fg: (_color: string, text: string): string => `${MAGENTA}${text}${RESET}`,
  },
}));
// Dynamic imports: mock.module() above must execute before the composer modules
// load, so hoisted static imports cannot work here. The split mirrors the
// runtime layout: shapes own the frames, editor owns the re-framing, status
// owns the text pipeline and the live providers.
const composer: ComposerShapesModule = await import("./surfaces/composer-shapes.ts");
const composerEditor: ComposerEditorModule = await import("./surfaces/composer-editor.ts");
const composerStatus: ComposerStatusModule = await import("./surfaces/composer-status.ts");

const BOX: TestComposerBox = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
};

function makeChromeContext(topContent: string, width = 80): TestChromeContext {
  return {
    width,
    paddingX: 0,
    borderColor: (value: string): string => `${GREEN}${value}${RESET}`,
    accentColor: (value: string): string => `${CYAN}${value}${RESET}`,
    surfaceColor: (value: string): string => value,
    box: BOX,
    topBorder: { content: topContent, width: mockVisibleWidth(topContent) },
  };
}

function makeRowContext(gutter: string, topContent = ""): TestRowContext {
  return {
    ...makeChromeContext(topContent),
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
    __widths: [],
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
const grayscaleBottomDock = (): TestComposerStyle => styleById(composer.MINIMAL_COMPOSER_STYLE.grayscaleBottomDock);
const grayscaleTopDock = (): TestComposerStyle => styleById(composer.MINIMAL_COMPOSER_STYLE.grayscaleTopDock);
const belowDock = (): TestComposerStyle => styleById(composer.MINIMAL_COMPOSER_STYLE.belowDock);

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
  setPluginConfigForTest(null);
  composerStatus.updateMinimalPromptEditorProviders(
    () => undefined,
    () => undefined,
    () => undefined,
  );
  composerEditor.stopComposerRefreshTimer?.();
};

describe("composer shape registration", () => {
  test("registers the colorful, grayscale, and below-dock composers", () => {
    expect(registered.map((shape) => shape.style.id)).toEqual([
      composer.MINIMAL_COMPOSER_STYLE.bottomDock,
      composer.MINIMAL_COMPOSER_STYLE.topDock,
      composer.MINIMAL_COMPOSER_STYLE.grayscaleBottomDock,
      composer.MINIMAL_COMPOSER_STYLE.grayscaleTopDock,
      composer.MINIMAL_COMPOSER_STYLE.belowDock,
    ]);
  });

  test("grayscale ids are distinct and labelled as grayscale", () => {
    const colorful: Record<string, true> = {
      [composer.MINIMAL_COMPOSER_STYLE.bottomDock]: true,
      [composer.MINIMAL_COMPOSER_STYLE.topDock]: true,
      [composer.MINIMAL_COMPOSER_STYLE.belowDock]: true,
    };
    for (const shape of registered) {
      const isGrayscale =
        shape.style.id === composer.MINIMAL_COMPOSER_STYLE.grayscaleBottomDock ||
        shape.style.id === composer.MINIMAL_COMPOSER_STYLE.grayscaleTopDock;
      expect(Object.hasOwn(colorful, shape.style.id)).toBe(!isGrayscale);
      expect(shape.label.includes("Grayscale")).toBe(isGrayscale);
    }
  });

  test("every shape shares the same frame contract", () => {
    for (const shape of registered) {
      expect(shape.style.sideBorders).toBe(false);
      expect(shape.style.verticalChrome).toBe(2);
      expect(shape.style.defaultPromptGutter).toBe("❯ ");
      expect(typeof shape.style.renderTop).toBe("function");
      expect(typeof shape.style.renderRow).toBe("function");
      expect(typeof shape.style.renderBottom).toBe("function");
    }
  });

  test("only the below dock leaves the closing rule to the last content row", () => {
    for (const shape of registered) {
      const below = shape.style.id === composer.MINIMAL_COMPOSER_STYLE.belowDock;
      expect(shape.style.renderBottom(makeChromeContext(STATUS)) === undefined).toBe(below);
    }
  });
});

describe("below dock", () => {
  test("frame rules carry no status and the closing rule rides the last content row", () => {
    resetProviders();
    const top = stripAnsi(belowDock().renderTop(makeChromeContext(STATUS)) ?? "");
    expect(top).toBe(`${BOX.topLeft}${"─".repeat(78)}${BOX.topRight}`);
    expect(belowDock().renderBottom(makeChromeContext(STATUS))).toBeUndefined();
  });

  test("last content row emits the closing rule and the status row below it", () => {
    resetProviders();
    // The host's shape preview pushes renderRow rows before renderBottom, so the
    // closing rule and the status row must ride the last content row.
    const rows = belowDock().renderRow(makeRowContext("❯ ", STATUS));
    expect(rows).toHaveLength(3);
    expect(stripAnsi(rows[0] ?? "")).toBe("❯ hello  ");
    const rule = stripAnsi(rows[1] ?? "");
    expect(rule.startsWith(BOX.bottomLeft)).toBe(true);
    expect(rule.endsWith(BOX.bottomRight)).toBe(true);
    expect(mockVisibleWidth(rows[1] ?? "")).toBe(80);
    const status = stripAnsi(rows[2] ?? "");
    expect(status).toContain("myproj");
    expect(status).toContain("main");
    expect(status).not.toContain("Plan");
    expect(mockVisibleWidth(rows[2] ?? "")).toBeLessThanOrEqual(80);
  });

  test("status row keeps the working prefix, effort label, gauge, and pinned mode chip", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, indicator: "diamond" });
    composerStatus.updateMinimalPromptEditorProviders(
      () => ({ percent: 50, contextWindow: 200_000 }),
      () => ({ enabled: false, paused: false }),
      () => ({ startedAt: Date.now() - 12_000 }),
    );
    try {
      const content = "Opus · \uf017 xhi ⌂ myproj ⎇ main ▶────50%────200K──◀";
      const status = stripAnsi(belowDock().renderRow(makeRowContext("❯ ", content))[2] ?? "");
      expect(status).toMatch(/[◈◉◎○]\s+12s/);
      expect(status).toContain("xhigh");
      expect(status).toContain("50%/200K");
      expect(status.endsWith("build")).toBe(true);
      expect(status).not.toContain("Plan");
      expect(mockVisibleWidth(status)).toBe(80);
    } finally {
      resetProviders();
    }
  });

  test("editor keeps the status row flush left under the frame and indents autocomplete", () => {
    resetProviders();
    const dockWidth = 40;
    const innerWidth = dockWidth - 4;
    const inner = [
      `╭${"─".repeat(innerWidth - 2)}╮`,
      `hello${" ".repeat(innerWidth - 5)}`,
      `╰${"─".repeat(innerWidth - 2)}╯`,
      "⬡ Opus ⌂ myproj ⎇ main",
      "› suggestion",
    ];
    const theme = makeEditorTheme(composer.MINIMAL_COMPOSER_STYLE.belowDock, inner);
    const editor = new composerEditor.MinimalPromptEditor({}, theme, {});
    const rows = editor.render(dockWidth);
    const plain = rows.map(stripAnsi);
    // The host wraps and scrolls the prompt at the width it is handed, and the frame adds
    // `EDITOR_FRAME_CHROME` columns around it: asking for the outer width would drop the prompt's
    // last columns from the painted frame.
    expect(theme.__widths).toEqual([innerWidth]);
    expect(rows).toHaveLength(5);
    expect(plain[0]?.startsWith(BOX.topLeft)).toBe(true);
    expect(plain[2]?.startsWith(BOX.bottomLeft)).toBe(true);
    expect(plain[3]).toBe("⬡ Opus ⌂ myproj ⎇ main");
    expect(plain[4]).toBe("  › suggestion");
    for (const row of rows) expect(mockVisibleWidth(row)).toBeLessThanOrEqual(dockWidth);
    expect(mockVisibleWidth(rows[0] ?? "")).toBe(dockWidth);
    expect(mockVisibleWidth(rows[2] ?? "")).toBe(dockWidth);
  });
});

test("all docks pin one mode indicator through build, plan, and paused transitions", () => {
  let status = { enabled: false, paused: false };
  composerStatus.updateMinimalPromptEditorProviders(
    () => undefined,
    () => status,
  );
  try {
    const ctx = makeChromeContext("Opus  myproj  main  Plan  Plan ", 100);
    for (const dock of [bottomDock(), topDock(), grayscaleBottomDock(), grayscaleTopDock()]) {
      const render = () => stripAnsi(`${dock.renderTop(ctx) ?? ""}\n${dock.renderBottom(ctx) ?? ""}`);
      status = { enabled: false, paused: false };
      expect(render().match(/build/g)).toHaveLength(1);
      expect(render()).not.toContain("Plan");
      status = { enabled: true, paused: false };
      expect(render().match(/Plan/g)).toHaveLength(1);
      expect(render()).toContain(" Plan");
      expect(render()).not.toContain("build");
      expect(render()).not.toContain("");
      status = { enabled: false, paused: true };
      expect(render().match(/Plan/g)).toHaveLength(1);
      expect(render()).toContain(" Plan ");
      expect(render()).not.toContain("build");
      status = { enabled: false, paused: false };
      expect(render()).not.toContain("Plan");
      expect(render().match(/build/g)).toHaveLength(1);
    }
  } finally {
    resetProviders();
  }
});

describe("colorful docks preserve theme colors", () => {
  test("top dock keeps project and frame colors", () => {
    resetProviders();
    const line = topDock().renderTop(makeChromeContext(STATUS));
    expect(line).toContain("myproj");
    expect(line).toContain(MAGENTA);
    expect(line).toContain(GREEN);
  });

  test("bottom dock strips native Plan from both rules", () => {
    resetProviders();
    const top = bottomDock().renderTop(makeChromeContext(STATUS));
    const bottom = bottomDock().renderBottom(makeChromeContext(STATUS));
    expect(top).toContain("myproj");
    expect(top).not.toContain("Plan");
    expect(stripAnsi(bottom ?? "")).not.toContain("Plan");
  });

  test("every dock strips duplicate native Plan copies", () => {
    resetProviders();
    const duplicated = "Opus ⌂ myproj ⎇ main 🗺 Plan 🗺 Plan ⏸";
    for (const dock of [bottomDock(), topDock(), grayscaleBottomDock(), grayscaleTopDock()]) {
      const top = dock.renderTop(makeChromeContext(duplicated)) ?? "";
      const bottom = dock.renderBottom(makeChromeContext(duplicated)) ?? "";
      expect(stripAnsi(top)).not.toContain("Plan");
      expect(stripAnsi(bottom)).not.toContain("Plan");
    }
  });

  test("top dock renders the full status on top and a plain rule below", () => {
    composerStatus.updateMinimalPromptEditorProviders(
      () => undefined,
      () => ({ enabled: true, paused: false }),
      () => undefined,
    );
    try {
      const top = topDock().renderTop(makeChromeContext(STATUS));
      expect(top).toContain("myproj");
      const bottom = topDock().renderBottom(makeChromeContext(STATUS)) ?? "";
      const plain = bottom.replace(new RegExp(ANSI_PART, "g"), "");
      expect(plain).not.toContain("Plan");
      expect(plain).not.toContain("myproj");
    } finally {
      resetProviders();
    }
  });

  test("live run prefixes spinner and elapsed ahead of project", () => {
    // Pin the indicator: the resolved config otherwise follows this machine's lockfile.
    setPluginConfigForTest({ ...DEFAULT_CONFIG, indicator: "diamond" });
    composerStatus.updateMinimalPromptEditorProviders(
      () => undefined,
      () => undefined,
      () => ({ startedAt: Date.now() - 12_000 }),
    );
    try {
      const native = "⬢ Muse Spark 1.3 Free  󰚩 Muse Spark 1.3 Free · 󰪥 xhigh ⌂ myproj ⎇ main";
      const top = stripAnsi(topDock().renderTop(makeChromeContext(native)) ?? "");
      const bottom = stripAnsi(bottomDock().renderBottom(makeChromeContext(native)) ?? "");
      for (const plain of [top, bottom]) {
        expect(plain).toMatch(/\b12s\b/);
        expect(plain).toMatch(/[◈◉◎○]/);
      }
      expect(top).toMatch(/^[^\w]*[◈◉◎○]\s+12s\s+Muse Spark/);
      resetProviders();
    } finally {
    }
  });

  test("idle session adds no prefix", () => {
    composerStatus.updateMinimalPromptEditorProviders(
      () => undefined,
      () => undefined,
      () => undefined,
    );
    try {
      const native = "⬢ Muse Spark 1.3 Free  󰚩 Muse Spark 1.3 Free · 󰪥 xhigh ⌂ myproj ⎇ main";
      const plain = stripAnsi(topDock().renderTop(makeChromeContext(native)) ?? "");
      expect(plain.match(/Muse Spark 1\.3 Free/gu) ?? []).toHaveLength(1);
      expect(plain).not.toMatch(/[◈◉◎○]/);
    } finally {
      resetProviders();
    }
  });
});

describe("grayscale docks collapse color to equal-RGB gray", () => {
  test("grayscale bottom dock strips native Plan without theme colors", () => {
    resetProviders();
    const top = grayscaleBottomDock().renderTop(makeChromeContext(STATUS)) ?? "";
    const bottom = grayscaleBottomDock().renderBottom(makeChromeContext(STATUS)) ?? "";
    expect(top).toContain("myproj");
    expect(top).not.toContain("Plan");
    expect(stripAnsi(bottom)).not.toContain("Plan");
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

  test("subagent job chunk does not remove the context gauge", () => {
    composerStatus.updateMinimalPromptEditorProviders(
      () => ({ percent: 50, contextWindow: 200_000 }),
      () => ({ enabled: true, paused: false }),
      () => ({ startedAt: Date.now() - 12_000 }),
    );
    try {
      // Native unshifts `⚙ N` onto the right segments when agents run; the
      // squeezed middle fill can collapse so no caps/% anchor survives.
      const squeezed = `Opus ⚡ 2 ◇ myproj ⎇ main`;
      for (const dock of [topDock(), bottomDock(), grayscaleTopDock(), grayscaleBottomDock()]) {
        const top = stripAnsi(dock.renderTop(makeChromeContext(squeezed)) ?? "");
        const bottom = stripAnsi(dock.renderBottom(makeChromeContext(squeezed)) ?? "");
        expect(`${top} ${bottom}`).toContain("50%/200K");
      }
    } finally {
      resetProviders();
    }
  });

  test("worktree project icon is recognized and keeps gauge in both docks", () => {
    composerStatus.updateMinimalPromptEditorProviders(
      () => ({ percent: 50, contextWindow: 200_000 }),
      () => ({ enabled: true, paused: false }),
      () => ({ startedAt: Date.now() - 12_000 }),
    );
    try {
      const worktreeStatus =
        "󰚩 Muse Spark 1.3 Free · 󰪥 xhigh > 5h 10% ─────50%─────────200K── 👥 1 <  fix-composer <  fix_composer <  Plan";
      for (const dock of [topDock(), bottomDock(), grayscaleTopDock(), grayscaleBottomDock()]) {
        const top = stripAnsi(dock.renderTop(makeChromeContext(worktreeStatus, 140)) ?? "");
        const bottom = stripAnsi(dock.renderBottom(makeChromeContext(worktreeStatus, 140)) ?? "");
        expect(`${top} ${bottom}`).toContain("50%/200K");
        expect(`${top} ${bottom}`).toContain("fix-composer");
      }
    } finally {
      resetProviders();
    }
  });

  test("every status-line separator keeps the project name on both docks", () => {
    composerStatus.updateMinimalPromptEditorProviders(
      () => ({ percent: 50, contextWindow: 200_000 }),
      () => undefined,
      () => undefined,
    );
    try {
      const project = "omp-minimal-output";
      const samples: Array<{ name: string; status: string }> = [
        {
          name: "powerline unicode",
          status: `󰚩 GPT ▶ 📁 ${project} ▶  main ▶────50%────200K──◀ session`,
        },
        {
          name: "powerline unicode path last",
          status: `󰚩 GPT ▶ 📁 ${project} ────50%────200K──◀ session`,
        },
        {
          name: "powerline nerd",
          status: `󰚩 GPT \ue0b0 📁 ${project} \ue0b0  main \ue0b0────50%────200K──\ue0b2 session`,
        },
        {
          name: "powerline nerd path last",
          status: `󰚩 GPT \ue0b0 📁 ${project} ────50%────200K──\ue0b2 session`,
        },
        {
          name: "powerline-thin unicode",
          status: `󰚩 GPT > 📁 ${project} >  main >────50%────200K──< session`,
        },
        {
          name: "powerline-thin nerd",
          status: `󰚩 GPT \ue0b1 📁 ${project} \ue0b1  main \ue0b1────50%────200K──\ue0b3 session`,
        },
        {
          name: "slash unicode",
          status: `󰚩 GPT / 📁 ${project} /  main ────50%────200K── session`,
        },
        {
          name: "slash nerd",
          status: `󰚩 GPT \ue0bb 📁 ${project} \ue0bb  main ────50%────200K── session`,
        },
        {
          name: "pipe unicode",
          status: `󰚩 GPT │ 📁 ${project} │  main ────50%────200K── session`,
        },
        {
          name: "pipe nerd",
          status: `󰚩 GPT \ue0b3 📁 ${project} \ue0b3  main ────50%────200K── session`,
        },
        {
          name: "block",
          status: `󰚩 GPT █ 📁 ${project} █  main ────50%────200K── session`,
        },
        {
          name: "none",
          status: `󰚩 GPT  📁 ${project}   main ────50%────200K── session`,
        },
        {
          name: "ascii",
          status: `󰚩 GPT > 📁 ${project} >  main >────50%────200K──< session`,
        },
        {
          name: "ascii folder",
          status: `GPT [D] ${project} @ main ────50%────200K── session`,
        },
      ];
      for (const sample of samples) {
        for (const dock of [topDock(), bottomDock(), grayscaleTopDock(), grayscaleBottomDock()]) {
          const top = stripAnsi(dock.renderTop(makeChromeContext(sample.status, 140)) ?? "");
          const bottom = stripAnsi(dock.renderBottom(makeChromeContext(sample.status, 140)) ?? "");
          expect(top, sample.name).toContain(project);
          expect(`${top} ${bottom}`, sample.name).toContain("50%/200K");
        }
      }
    } finally {
      resetProviders();
    }
  });

  test("renderers fail open without throwing on malformed or empty context", () => {
    resetProviders();
    const emptyCtx = makeChromeContext("", 40);
    for (const dock of [topDock(), bottomDock(), grayscaleTopDock(), grayscaleBottomDock()]) {
      expect(() => dock.renderTop(emptyCtx)).not.toThrow();
      expect(() => dock.renderBottom(emptyCtx)).not.toThrow();
    }
  });

  test("narrow width keeps the gauge ahead of tail content", () => {
    composerStatus.updateMinimalPromptEditorProviders(
      () => ({ percent: 50, contextWindow: 200_000 }),
      () => ({ enabled: true, paused: false }),
      () => ({ startedAt: Date.now() - 12_000 }),
    );
    try {
      const squeezed = `Opus ⚡ 2 ◇ myproj ⎇ main with-a-very-long-tail-that-must-truncate`;
      const narrow = { ...makeChromeContext(squeezed), width: 40 };
      expect(stripAnsi(topDock().renderTop(narrow) ?? "")).toContain("50%/200K");
      expect(stripAnsi(bottomDock().renderBottom(narrow) ?? "")).toContain("50%/200K");
    } finally {
      resetProviders();
    }
  });

  test("grayscale context gauge keeps its label but loses accent and frame colors", () => {
    composerStatus.updateMinimalPromptEditorProviders(
      () => ({ percent: 50, contextWindow: 200_000 }),
      () => ({ enabled: true, paused: false }),
      () => undefined,
    );
    try {
      const content = `Opus ▶────────────────────◀ ⌂ myproj ⎇ main 🗺 Plan`;
      const colorful = topDock().renderTop(makeChromeContext(content)) ?? "";
      expect(colorful).toContain(CYAN);
      expect(colorful).toContain("50%/200K");
      const gray = grayscaleTopDock().renderTop(makeChromeContext(content)) ?? "";
      expect(gray).toContain("50%/200K");
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
    const editor = new composerEditor.MinimalPromptEditor(
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
    const editor = new composerEditor.MinimalPromptEditor(
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
    const editor = new composerEditor.MinimalPromptEditor({}, makeEditorTheme("box", inner), {});
    expect(editor.render(40)).toEqual(inner);
  });

  test("narrow widths fall through to the base editor even for grayscale styles", () => {
    const inner = ["alpha", "beta"];
    const editor = new composerEditor.MinimalPromptEditor(
      {},
      makeEditorTheme(composer.MINIMAL_COMPOSER_STYLE.grayscaleTopDock, inner),
      {},
    );
    expect(editor.render(8)).toEqual(inner);
  });
});
describe("composer layout is presented correctly", () => {
  test("top dock chrome fills the full width with padded corners", () => {
    composerStatus.updateMinimalPromptEditorProviders(
      () => undefined,
      () => ({ enabled: true, paused: false }),
      () => undefined,
    );
    try {
      const width = 80;
      const line = topDock().renderTop(makeChromeContext(STATUS)) ?? "";
      // Full status stays on one visible row: project and Git, with native Plan stripped.
      const plain = stripAnsi(line);
      expect(plain).toContain("myproj");
      expect(plain).toContain("main");
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
    // Top keeps project/Git right-docked; native Plan appears in neither rule.
    expect(topPlain).toContain("myproj");
    expect(topPlain).not.toContain("Plan");
    expect(bottomPlain).not.toContain("Plan");
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
      const editor = new composerEditor.MinimalPromptEditor({}, makeEditorTheme(styleId, frameInner(36)), {});
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
    const editor = new composerEditor.MinimalPromptEditor(
      {},
      makeEditorTheme(composer.MINIMAL_COMPOSER_STYLE.bottomDock, inner(36)),
      {},
    );
    const rows = editor.render(40);
    expect(rows.some((row) => stripAnsi(row).includes("xhigh"))).toBe(true);
  });
});

describe("composer usage filtering and auto-refresh", () => {
  test("retains only 5h with reset time when both 5h and 7d are present and inverts to remaining %", () => {
    resetProviders();
    const status = "󰚩 GPT · \uf017 5h 0% (4h 58m) · 7d 7% (5d 16h) ⌂ myproj ⎇ main";
    const bottom = bottomDock().renderBottom(makeChromeContext(status)) ?? "";
    const plain = stripAnsi(bottom);
    expect(plain).toContain("5h 100% (4h 58m)");
    expect(plain).not.toContain("7d");
    expect(plain).not.toContain("5d 16h");
  });

  test("retains 7d with reset time when 5h is not present and inverts to remaining %", () => {
    resetProviders();
    const status = "󰚩 GPT · \uf017 7d 7% (5d 16h) ⌂ myproj ⎇ main";
    const bottom = bottomDock().renderBottom(makeChromeContext(status)) ?? "";
    const plain = stripAnsi(bottom);
    expect(plain).toContain("7d 93% (5d 16h)");
    expect(plain).not.toContain("5h");
  });

  test("retains 7d when 1d and 7d are present without 5h and inverts to remaining %", () => {
    resetProviders();
    const status = "󰚩 GPT · \uf017 1d 10% (12h) · 7d 7% (5d 16h) ⌂ myproj ⎇ main";
    const bottom = bottomDock().renderBottom(makeChromeContext(status)) ?? "";
    const plain = stripAnsi(bottom);
    expect(plain).toContain("7d 93% (5d 16h)");
    expect(plain).not.toContain("1d");
    expect(plain).not.toContain("5h");
  });

  test("strips tier text between icon and chosen window and displays remaining %", () => {
    resetProviders();
    const status = "󰚩 GPT · \uf017 Plus 5h 0% (4h 58m) · 7d 7% (5d 16h) ⌂ myproj ⎇ main";
    const bottom = bottomDock().renderBottom(makeChromeContext(status)) ?? "";
    const plain = stripAnsi(bottom);
    expect(plain).toContain("\uf017 5h 100% (4h 58m)");
    expect(plain).not.toContain("Plus");
    expect(plain).not.toContain("7d");
  });

  test("preserves ANSI color sequences on the selected usage window with remaining %", () => {
    resetProviders();
    const status = `󰚩 GPT · \uf017 ${GREEN}5h 0%${RESET} ${MAGENTA}(4h 58m)${RESET} · ${YELLOW}7d 7%${RESET} ⌂ myproj ⎇ main`;
    const bottom = bottomDock().renderBottom(makeChromeContext(status)) ?? "";
    expect(bottom).toContain(`${GREEN}5h 100%${RESET}`);
    expect(bottom).toContain(`${MAGENTA}(4h 58m)${RESET}`);
    expect(stripAnsi(bottom)).not.toContain("7d");
  });

  test("inverts 0% to 100% when percentage is wrapped in OMP ANSI color codes", () => {
    resetProviders();
    // OMP wraps the percentage in theme ANSI codes: 5h \x1b[32m0%\x1b[39m (4h 58m)
    const status = `󰚩 GPT · \uf017 5h \x1b[32m0%\x1b[39m \x1b[2m(4h 58m)\x1b[22m · 7d \x1b[33m7%\x1b[39m ⌂ myproj ⎇ main`;
    const bottom = bottomDock().renderBottom(makeChromeContext(status)) ?? "";
    const plain = stripAnsi(bottom);
    expect(plain).toContain("5h 100% (4h 58m)");
    expect(plain).not.toMatch(/\b0%/);
    expect(plain).not.toContain("7d");
  });
  test("handles alternate icon variants such as unicode timer and ascii time:", () => {
    resetProviders();
    const statusUnicode = "Opus · ⏱ 5h 20% (1h 10m) · 7d 50% (2d) ⌂ myproj ⎇ main";
    const bottomUnicode = stripAnsi(bottomDock().renderBottom(makeChromeContext(statusUnicode)) ?? "");
    expect(bottomUnicode).toContain("⏱ 5h 80% (1h 10m)");
    expect(bottomUnicode).not.toContain("7d");

    const statusAscii = "Opus · time: 7d 40% (3d) ⌂ myproj ⎇ main";
    const bottomAscii = stripAnsi(bottomDock().renderBottom(makeChromeContext(statusAscii)) ?? "");
    expect(bottomAscii).toContain("time: 7d 60% (3d)");
  });

  test("getComposerRefreshIntervalMs returns default 60s when unconfigured", () => {
    resetProviders();
    expect(composerEditor.getComposerRefreshIntervalMs()).toBe(60_000);
  });

  test("getComposerRefreshIntervalMs uses plugin config value for refreshing", () => {
    try {
      resetProviders();
      setPluginConfigForTest({ ...DEFAULT_CONFIG, composerRefreshInterval: 15 });
      expect(composerEditor.getComposerRefreshIntervalMs()).toBe(15_000);

      setPluginConfigForTest({ ...DEFAULT_CONFIG, composerRefreshInterval: 5 });
      expect(composerEditor.getComposerRefreshIntervalMs()).toBe(5_000);

      setPluginConfigForTest({ ...DEFAULT_CONFIG, composerRefreshInterval: 120 });
      expect(composerEditor.getComposerRefreshIntervalMs()).toBe(120_000);
    } finally {
      resetProviders();
    }
  });

  test("syncComposerRefreshTimer schedules render requests using plugin config value", () => {
    try {
      resetProviders();
      setPluginConfigForTest({ ...DEFAULT_CONFIG, composerRefreshInterval: 10 });
      let renders = 0;
      const mockTui = {
        requestRender: () => {
          renders += 1;
        },
      };
      composerEditor.syncComposerRefreshTimer(mockTui as any);
      expect(typeof composerEditor.stopComposerRefreshTimer).toBe("function");
      composerEditor.stopComposerRefreshTimer();
    } finally {
      resetProviders();
    }
  });

  test("MinimalPromptEditor syncs refresh timer using plugin config interval", () => {
    try {
      resetProviders();
      setPluginConfigForTest({ ...DEFAULT_CONFIG, composerRefreshInterval: 25 });
      let renders = 0;
      const mockTui = {
        requestRender: () => {
          renders += 1;
        },
      };
      const inner = (innerWidth: number): string[] => [
        `╭${"─".repeat(innerWidth - 2)}╮`,
        `hello${" ".repeat(innerWidth - 5)}`,
        `╰ ${"─".repeat(innerWidth - 2)}╯`,
      ];
      const editor = new composerEditor.MinimalPromptEditor(
        mockTui as any,
        makeEditorTheme(composer.MINIMAL_COMPOSER_STYLE.bottomDock, inner(36)),
        {} as any,
      );
      editor.render(40);
      expect(composerEditor.getComposerRefreshIntervalMs()).toBe(25_000);
      composerEditor.stopComposerRefreshTimer();
    } finally {
      resetProviders();
    }
  });
});

/*
 * The host rewrites its status-line text for every `statusLine` option: preset (default, minimal,
 * compact, full, nerd, ascii, custom), separator, and context-line mode each produce a different
 * segment set — no model, no path, hostname/session/time/cost segments, or a context gauge drawn as
 * a rule run instead of caps. The docks parse that text, so every preset must render without
 * throwing and must keep the row inside the dock width.
 *
 * Fixtures: raw status contents captured from OMP 18.3.0 with `statusLine.preset` switched per run.
 */
const PRESET_STATUS: Record<string, string> = {
  ascii:
    "\u001b[49m\u001b[39m \u001b[38;2;211;134;155m\uec19 Gemini 3.1 Pro\u001b[39m\u001b[38;2;211;134;155m \u00b7 \udb82\ude9e min\u001b[39m \u001b[38;2;102;92;84m \u001b[39m \u001b[38;2;142;192;124m\uf014 omp-probe-run\u001b[39m \u001b[0m\u001b[49m\u001b[38;2;142;192;124m\u25001%\u001b[38;2;69;133;136m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u001b[38;2;146;131;116m\udb81\udd5d\u001b[38;2;118;144;108m\udb80\udc68\u001b[38;2;69;133;136m\u2500\u2500\u2500\u2500\u2500\u2500\u001b[38;2;118;144;108m1M\u001b[38;2;69;133;136m\u2500\u001b[39m\u001b[49m\u001b[39m \u001b[38;2;211;134;155m\udb81\ude7a\u001b[39m \u001b[0m",
  compact:
    "\u001b[49m\u001b[39m \u001b[38;2;211;134;155m\uec19 Gemini 3.1 Pro\u001b[39m \u001b[0m\u001b[49m\u001b[38;2;142;192;124m\u25001%\u001b[38;2;69;133;136m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u001b[38;2;146;131;116m\udb81\udd5d\u001b[38;2;69;133;136m\u2500\u001b[38;2;118;144;108m\udb80\udc68\u001b[38;2;69;133;136m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u001b[38;2;118;144;108m1M\u001b[38;2;69;133;136m\u2500\u001b[39m\u001b[49m\u001b[39m \u001b[38;2;211;134;155m\udb81\ude7a\u001b[39m \u001b[0m",
  custom:
    "\u001b[49m\u001b[39m \u001b[38;2;211;134;155m\uec19 Gemini 3.1 Pro\u001b[39m\u001b[38;2;211;134;155m \u00b7 \udb82\ude9e min\u001b[39m \u001b[38;2;102;92;84m \u001b[39m \uf017 5h \u001b[38;2;146;131;116m0%\u001b[39m\u001b[38;2;146;131;116m (4h 57m)\u001b[39m \u00b7 7d \u001b[38;2;146;131;116m0%\u001b[39m\u001b[38;2;146;131;116m (7d)\u001b[39m \u001b[0m\u001b[49m\u001b[38;2;142;192;124m\u25002%\u001b[38;2;69;133;136m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u001b[38;2;118;144;108m\udb80\udc68\u001b[38;2;69;133;136m\u2500\u2500\u001b[38;2;118;144;108m1M\u001b[38;2;69;133;136m\u2500\u001b[39m\u001b[49m\u001b[39m \u001b[38;2;142;192;124m\uf014 omp-probe-run\u001b[39m \u001b[0m",
  default:
    "\u001b[49m\u001b[39m \u001b[38;2;124;111;100m\udb83\udd57\u001b[39m \u001b[38;2;102;92;84m \u001b[39m \u001b[38;2;211;134;155m\uec19 Gemini 3.1 Pro\u001b[39m\u001b[38;2;211;134;155m \u00b7 \udb82\ude9e min\u001b[39m \u001b[38;2;102;92;84m \u001b[39m \u001b[38;2;142;192;124m\uf014 omp-probe-run\u001b[39m \u001b[38;2;102;92;84m \u001b[39m \u001b[38;2;211;134;155m\udb81\ude7a\u001b[39m \u001b[0m\u001b[49m\u001b[38;2;142;192;124m\u25001%\u001b[38;2;69;133;136m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u001b[38;2;146;131;116m\udb81\udd5d\u001b[38;2;118;144;108m\udb80\udc68\u001b[38;2;69;133;136m\u2500\u2500\u2500\u2500\u2500\u001b[38;2;118;144;108m1M\u001b[38;2;69;133;136m\u2500\u001b[39m",
  full: "\u001b[49m\u001b[39m \u001b[38;2;124;111;100m\udb83\udd57\u001b[39m \u001b[38;2;102;92;84m \u001b[39m \uf109 omarchy \u001b[38;2;102;92;84m \u001b[39m \u001b[38;2;211;134;155m\uec19 Gemini 3.1 Pro\u001b[39m\u001b[38;2;211;134;155m \u00b7 \udb82\ude9e min\u001b[39m \u001b[38;2;102;92;84m \u001b[39m \u001b[38;2;142;192;124m\uf014 omp-probe-run\u001b[39m \u001b[0m\u001b[49m\u001b[38;2;142;192;124m\u25001%\u001b[38;2;69;133;136m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u001b[38;2;146;131;116m\udb81\udd5d\u001b[38;2;118;144;108m\udb80\udc68\u001b[38;2;69;133;136m\u2500\u2500\u001b[38;2;118;144;108m1M\u001b[38;2;69;133;136m\u2500\u001b[39m\u001b[49m\u001b[39m \u001b[38;2;211;134;155m\udb81\ude7a\u001b[39m \u001b[38;2;102;92;84m \u001b[39m \uf017 11:23 \u001b[0m",
  minimal:
    "\u001b[49m\u001b[39m \u001b[38;2;142;192;124m\uf014 omp-probe-run\u001b[39m \u001b[0m\u001b[49m\u001b[38;2;142;192;124m\u25001%\u001b[38;2;69;133;136m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u001b[38;2;146;131;116m\udb81\udd5d\u001b[38;2;69;133;136m\u2500\u2500\u001b[38;2;118;144;108m\udb80\udc68\u001b[38;2;69;133;136m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u001b[38;2;118;144;108m1M\u001b[38;2;69;133;136m\u2500\u001b[39m",
  nerd: "\u001b[49m\u001b[39m \u001b[38;2;124;111;100m\udb83\udd57\u001b[39m \u001b[38;2;102;92;84m \u001b[39m \uf109 omarchy \u001b[38;2;102;92;84m \u001b[39m \u001b[38;2;211;134;155m\uec19 Gemini 3.1 Pro\u001b[39m\u001b[38;2;211;134;155m \u00b7 \udb82\ude9e min\u001b[39m \u001b[38;2;102;92;84m \u001b[39m \u001b[38;2;142;192;124m\uf014 omp-probe-run\u001b[39m \u001b[38;2;102;92;84m \u001b[39m \udb80\udc51 01a0d6ce \u001b[0m\u001b[49m\u001b[38;2;142;192;124m\u25001%\u001b[38;2;69;133;136m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u001b[38;2;118;144;108m\udb80\udc68\u001b[38;2;69;133;136m\u2500\u2500\u001b[38;2;118;144;108m1M\u001b[38;2;69;133;136m\u2500\u001b[39m\u001b[49m\u001b[39m \u001b[38;2;211;134;155m\udb81\ude7a\u001b[39m \u001b[0m",
};

describe("every status-line preset renders through the docks", () => {
  /** Raw status content of a *named* session with `statusLine.preset: minimal` (session_name included). */
  const NAMED_SESSION_STATUS =
    "\u001b[49m\u001b[39m \u001b[38;2;142;192;124m\uf014 omp-probe-run\u001b[39m \u001b[0m\u001b[49m\u001b[38;2;87;250;132m\u25002%\u001b[38;2;69;133;136m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u001b[38;2;146;131;116m\udb81\udd5d\u001b[38;2;69;133;136m\u2500\u001b[38;2;102;187;126m\udb80\udc68\u001b[38;2;69;133;136m\u2500\u2500\u2500\u2500\u2500\u2500\u001b[38;2;102;187;126m1M\u001b[38;2;69;133;136m\u2500\u001b[39m\u001b[49m\u001b[39m \u001b[38;2;87;250;132mFix Composer Click Agent Crash Loop\u001b[39m \u001b[0m";
  const NAMED_SESSION_TITLE = "Fix Composer Click Agent Crash Loop";

  const DOCK_WIDTH = 96;

  function presetContext(content: string) {
    return makeChromeContext(content, DOCK_WIDTH);
  }

  function presetRow(content: string) {
    // Same shape as `makeRowContext`, at the dock width instead of the helper's default.
    return {
      ...presetContext(content),
      text: "hello",
      pad: "  ",
      gutter: "❯ ",
      isLastRow: true,
      cursorOverflow: 0,
      imeSafeCursorTail: false,
      scrollbarThumb: false,
    };
  }

  function presetProviders(usage = { percent: 2, contextWindow: 1_000_000 }) {
    composerStatus.updateMinimalPromptEditorProviders(
      () => usage,
      () => ({ enabled: false, paused: false }),
    );
  }

  test("status rules fill the dock width and keep the mode chip", () => {
    for (const [preset, content] of Object.entries(PRESET_STATUS)) {
      for (const dock of [bottomDock(), topDock(), grayscaleBottomDock(), grayscaleTopDock()]) {
        presetProviders();
        const ctx = presetContext(content);
        const rows = [dock.renderTop(ctx), dock.renderBottom(ctx)].filter(
          (row): row is string => typeof row === "string" && row.length > 0,
        );
        for (const row of rows) {
          expect(mockVisibleWidth(row), `${preset}/${dock.id} rule width`).toBe(DOCK_WIDTH);
        }
        expect(
          rows.some((row) => stripAnsi(row).includes("build")),
          `${preset}/${dock.id} mode chip`,
        ).toBe(true);
      }
    }
  });

  test("the below dock row fills the dock width, keeps the chip, and replaces the host gauge", () => {
    for (const [preset, content] of Object.entries(PRESET_STATUS)) {
      presetProviders();
      const status = stripAnsi(belowDock().renderRow(presetRow(content))[2] ?? "");
      expect(mockVisibleWidth(status), `${preset} below-dock width`).toBe(DOCK_WIDTH);
      expect(status, `${preset} below-dock mode chip`).toContain("build");
      // The host draws its context gauge as a rule run; the dock swaps in its own gauge.
      expect(status, `${preset} gauge`).toContain("2%/1M");
      expect(status.includes("─1%"), `${preset} kept the host gauge rule`).toBe(false);
    }
  });

  test("the editor frames the below-dock rows for every preset", () => {
    const innerWidth = DOCK_WIDTH - 4;
    for (const [preset, content] of Object.entries(PRESET_STATUS)) {
      presetProviders();
      const hostRows = [
        belowDock().renderTop(presetContext(content)) ?? "",
        ...belowDock().renderRow(presetRow(content)),
      ];
      const editor = new composerEditor.MinimalPromptEditor(
        {},
        makeEditorTheme(composer.MINIMAL_COMPOSER_STYLE.belowDock, hostRows),
        {},
      );
      const rows = editor.render(DOCK_WIDTH);
      const plain = rows.map(stripAnsi);
      for (const row of rows) {
        expect(mockVisibleWidth(row), `${preset} editor row width`).toBeLessThanOrEqual(DOCK_WIDTH);
      }
      expect(plain[0]?.startsWith(BOX.topLeft), `${preset} top rule`).toBe(true);
      const statusIndex = plain.findIndex((row) => row.includes("build"));
      expect(statusIndex, `${preset} status row`).toBeGreaterThan(0);
      // The status row rides flush left under the closing rule, never inside the frame.
      expect(plain[statusIndex]?.startsWith(BOX.vertical), `${preset} status row framed`).toBe(false);
      expect(mockVisibleWidth(rows[statusIndex] ?? "")).toBeLessThanOrEqual(DOCK_WIDTH);
    }
  });

  test("a crash dump in the status content never reaches the frame", () => {
    // A failed status segment (or an extension that stringifies an exception into its hook status)
    // hands the dock a stack trace. Painting it would replace the status row with a multi-line crash
    // dump and break the frame, so the docks drop it and keep their own chrome.
    const dump =
      "TypeError: undefined is not an object (evaluating 'segment.render')\n" +
      "    at render (/bundle.js:1:2)\n    at frame (/bundle.js:3:4)";
    const oneLine = "TypeError: undefined is not an object (evaluating 'segment.render')";
    const ansiHead = `\x1b[31m${oneLine}\x1b[39m`;

    for (const content of [dump, oneLine, ansiHead]) {
      for (const dock of [bottomDock(), topDock(), grayscaleBottomDock(), grayscaleTopDock()]) {
        presetProviders();
        const ctx = presetContext(content);
        const rows = [dock.renderTop(ctx), dock.renderBottom(ctx)].filter(
          (row): row is string => typeof row === "string" && row.length > 0,
        );
        for (const row of rows) {
          expect(stripAnsi(row), `${dock.id} leaked a newline`).not.toContain("\n");
          expect(stripAnsi(row), `${dock.id} painted the dump`).not.toContain("TypeError");
          expect(mockVisibleWidth(row), `${dock.id} rule width`).toBe(DOCK_WIDTH);
        }
      }
      presetProviders();
      const belowRows = belowDock().renderRow(presetRow(content));
      expect(belowRows, "below dock row count").toHaveLength(3);
      for (const row of belowRows) {
        expect(stripAnsi(row), "below dock leaked a newline").not.toContain("\n");
        expect(stripAnsi(row), "below dock painted the dump").not.toContain("TypeError");
      }
      expect(mockVisibleWidth(belowRows[2] ?? ""), "below dock status width").toBe(DOCK_WIDTH);
    }
  });

  test("ordinary multi-line status content is flattened onto the one row", () => {
    presetProviders();
    const rows = belowDock().renderRow(presetRow("Opus ⌂ myproj\n⎇ main\n"));
    const status = stripAnsi(rows[2] ?? "");
    expect(status, "flattened status").not.toContain("\n");
    expect(status, "flattened status").toContain("myproj");
    expect(status, "flattened status").toContain("main");
    expect(mockVisibleWidth(rows[2] ?? ""), "flattened width").toBe(DOCK_WIDTH);
  });

  test("drops the host's session title from the status row", () => {
    // `session_name` is the auto-generated task title: presets that list it paint a whole task name
    // (often one that reads like the failure it describes) into the dock's status row.
    expect(stripAnsi(NAMED_SESSION_STATUS), "fixture carries the title").toContain(NAMED_SESSION_TITLE);
    const ctx = presetContext(NAMED_SESSION_STATUS);

    composerStatus.updateMinimalPromptEditorProviders(
      () => ({ percent: 2, contextWindow: 1_000_000 }),
      () => ({ enabled: false, paused: false }),
      () => undefined,
      () => NAMED_SESSION_TITLE,
    );
    const status = stripAnsi(belowDock().renderRow(presetRow(NAMED_SESSION_STATUS))[2] ?? "");
    expect(status, "title dropped").not.toContain(NAMED_SESSION_TITLE);
    expect(status, "title dropped (prefix)").not.toContain("Crash Loop");
    expect(status, "project kept").toContain("omp-probe-run");
    expect(status, "gauge kept").toContain("2%/1M");
    expect(status.includes("─2%"), "host gauge rule kept").toBe(false);
    expect(mockVisibleWidth(status), "row width").toBe(DOCK_WIDTH);

    // A title that is only a slice of another segment must not be cut out of it.
    composerStatus.updateMinimalPromptEditorProviders(
      () => ({ percent: 2, contextWindow: 1_000_000 }),
      () => ({ enabled: false, paused: false }),
      () => undefined,
      () => "probe",
    );
    expect(stripAnsi(belowDock().renderRow(presetRow(NAMED_SESSION_STATUS))[2] ?? "")).toContain("omp-probe-run");

    // No session name available: the content passes through untouched (fail open).
    composerStatus.updateMinimalPromptEditorProviders(
      () => ({ percent: 2, contextWindow: 1_000_000 }),
      () => ({ enabled: false, paused: false }),
    );
    expect(stripAnsi(composerStatus.decorateStatusContent(NAMED_SESSION_STATUS, ctx))).toContain(NAMED_SESSION_TITLE);
  });

  test("unknown, empty, and oversized content still renders inside the dock width", () => {
    const oversized = `${PRESET_STATUS.full ?? ""} ${"segment ".repeat(60)}`;
    for (const content of ["", "plain status", "\x1b[32mweird\x1b[39m", oversized]) {
      presetProviders();
      const status = belowDock().renderRow(presetRow(content))[2] ?? "";
      expect(mockVisibleWidth(status)).toBeLessThanOrEqual(DOCK_WIDTH);
      const rule = belowDock().renderTop(presetContext(content)) ?? "";
      expect(mockVisibleWidth(rule)).toBe(DOCK_WIDTH);
    }
  });
});
describe("the composer status surface keeps crash dumps out", () => {
  test("recognises crash dumps and leaves ordinary status text alone", () => {
    for (const dump of [
      "TypeError: undefined is not an object (evaluating 'segment.render')",
      "Error: boom",
      "\x1b[31mRangeError: Invalid string length\x1b[39m",
      "⚠ TypeError: undefined is not an object",
      "line one\n    at render (/bundle.js:1:2)",
    ]) {
      expect(composerStatus.isCrashDumpText(dump), JSON.stringify(dump.slice(0, 40))).toBe(true);
    }
    for (const ok of [
      "✓ Headroom -20% (1,234 saved)",
      "○ Headroom off",
      "Opus ⌂ myproj ⎇ main",
      '⚠ Could not connect to "srv" yet',
      "Error rate: 3",
      "Todo 3/7 · next task",
    ]) {
      expect(composerStatus.isCrashDumpText(ok), ok).toBe(false);
    }
  });

  test("the host status wrapper drops dump rows, keeps real ones, and restores on disable", () => {
    const nativeRows = [
      "✓ Headroom -20% saved",
      "TypeError: undefined is not an object (evaluating 'segment.render') at render (/bundle.js:1:2)",
      "○ Headroom off",
    ];
    const wrapper: { render: (width: number) => string[] } = { render: (_width: number) => [...nativeRows] };
    const restore = composerStatus.installStatusRowGuard(wrapper);
    expect(restore, "guard installed").toBeDefined();
    expect(wrapper.render(80)).toEqual(["✓ Headroom -20% saved", "○ Headroom off"]);
    restore?.();
    expect(wrapper.render(80)).toEqual(nativeRows);
  });

  test("a dump in the status content renders no status text, multi-line text is flattened", () => {
    expect(composerStatus.dockStatusContent("TypeError: x\n    at y")).toBe("");
    expect(composerStatus.dockStatusContent("Opus ⌂ myproj\n⎇ main")).toBe("Opus ⌂ myproj ⎇ main");
  });
});
