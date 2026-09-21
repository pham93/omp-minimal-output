import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Container } from "@oh-my-pi/pi-tui";
import { renderImagePlaceholderBox } from "../cards/card-primitives.ts";
import { renderWriteCard } from "../cards/write-card.ts";
import { renderPrettyEditCard } from "../cards/edit-card.ts";
import { renderEvalCard } from "../cards/eval-card.ts";
import { renderWebSearchCard } from "../cards/web-search-card.ts";
import { renderTaskCard } from "../cards/task-card.ts";
import { renderHubCard } from "../cards/hub-card.ts";
import { GroupedToolManager, formatSearchDetails } from "../cards/grouped-tool-card.ts";
import { renderDensityTodoHeader } from "./todos-header.ts";
import { formatRowLine, paintAt } from "../core/theme.ts";
import { truncatePlain } from "../core/text.ts";
import { thinkingRailLines } from "./thinking-widget.ts";
import { warningIconFrame } from "./warning-skin.ts";

let activeDemoSeq = 0;

const WIDGET_KEY = "minimal-demo";

const DEMO_WRITE_LINES = [
  'import { Database } from "bun:sqlite";',
  'import * as fs from "node:fs/promises";',
  'import { resolve } from "node:path";',
  "",
  "export interface ServerConfig {",
  "  port: number;",
  "  host: string;",
  "  ssl: boolean;",
  "  workers: number;",
  "}",
  "",
  "export class MicroserviceServer {",
  "  private isRunning = false;",
  "  private connections = 0;",
  "",
  "  constructor(private readonly config: ServerConfig) {}",
  "",
  "  public async start(): Promise<void> {",
  "    this.isRunning = true;",
  "    console.log(`Server starting on port ${this.config.port}...`);",
  "  }",
  "",
  "  public async stop(): Promise<void> {",
  "    this.isRunning = false;",
  "    console.log('Server stopped gracefully.');",
  "  }",
  "",
  "  public getStats(): { connections: number; active: boolean } {",
  "    return { connections: this.connections, active: this.isRunning };",
  "  }",
  "}",
  "",
  "export default new MicroserviceServer({ port: 8080, host: '0.0.0.0', ssl: false, workers: 4 });",
];

const sleep = (ms: number, seq?: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    if (interval) clearInterval(interval);
    resolve();
  }, ms);
  const interval =
    seq !== undefined
      ? setInterval(() => {
          if (seq !== activeDemoSeq) {
            clearTimeout(timer);
            clearInterval(interval);
            resolve();
          }
        }, 20)
      : undefined;
  return promise;
};

function renderGroupedDemo(theme: unknown): Container {
  const groups = new GroupedToolManager({
    rowIsLive: () => false,
    activityLabel: () => "Running test suite & inspecting project",
    activityRunId: () => "demo:run",
    activityStartedAt: () => Date.now() - 1200,
  });

  const frozen = { gid: "demo:run", label: "Running test suite & inspecting project" };

  groups.renderToolVisual(
    theme,
    "bash:demo",
    {
      body: "$ bun test",
      live: false,
      error: false,
      right: "(0.2s)",
      details: [
        "118 pass",
        '@@ -128,7 +128,7 @@ describe("runPluginDemo", () => {',
        "-    const { ctx, widgets } = createMockCtx();",
        "+    const { ctx, widgets, notifications } = createMockCtx();",
      ],
    },
    frozen,
  );

  groups.renderToolVisual(
    theme,
    "demo:read",
    {
      body: "Read package.json",
      live: false,
      error: false,
      right: "(4ms)",
      details: [],
    },
    frozen,
  );

  groups.renderToolVisual(
    theme,
    "demo:grep",
    {
      body: 'Grep "TOOL_EXECUTION_PADDING_X"',
      live: false,
      error: false,
      right: "(8ms)",
      details: formatSearchDetails(
        theme,
        ["src/config.ts: 1 hit (first 1 shown)", "src/config.ts:14:export const DEFAULT_PORT = 3000;"],
        "DEFAULT_PORT",
      ),
    },
    frozen,
  );

  return groups.paintGroup(theme, "demo:run");
}

function renderEditDemo(theme: unknown): Container {
  const args = {
    path: "src/config.ts",
    edits: [
      {
        path: "src/config.ts",
        op: "PUT",
      },
    ],
  };

  const diffText = [
    " 14| export const DEFAULT_PORT = 3000;",
    '-15| export const HOST = "127.0.0.1";',
    '+15| export const HOST = "0.0.0.0";',
    "+16| export const ENABLE_METRICS = true;",
    " 17| export const TIMEOUT_MS = 5000;",
  ].join("\n");

  const result = {
    content: [{ type: "text", text: diffText }],
    details: {
      path: "src/config.ts",
      added: 2,
      removed: 1,
      diff: diffText,
      durationMs: 45,
    },
  };

  return renderPrettyEditCard(theme, args, result, { expanded: true }, false);
}

function renderEvalDemo(theme: unknown): Container {
  return renderEvalCard(
    theme,
    {
      code: 'const calculateLatency = (samples) => samples.reduce((a, b) => a + b, 0) / samples.length;\nconsole.log("p50 latency:", calculateLatency([12, 14, 11, 15, 13]), "ms");',
      language: "js",
      title: "benchmark summary",
    },
    {
      content: [{ type: "text", text: "p50 latency: 13 ms" }],
      details: { durationMs: 25 },
    },
    { expanded: true },
    false,
    "demo:eval",
  );
}

function renderWebSearchDemo(theme: unknown): Container {
  return renderWebSearchCard(
    theme,
    { query: "bun test runner performance" },
    {
      content: [{ type: "text", text: "Search results retrieved" }],
      details: {
        response: {
          sources: [
            { title: "Bun test runner documentation & CLI", url: "https://bun.sh/docs/cli/test" },
            { title: "Bun v1.4 release notes — fast test assertions", url: "https://bun.sh/blog/bun-v1.4" },
            { title: "Optimizing CI workflows with Bun", url: "https://bun.sh/guides/ci" },
          ],
        },
        durationMs: 180,
      },
    },
    { expanded: true },
    "demo:web_search",
  );
}

function renderTaskDemo(theme: unknown): Container {
  return renderTaskCard(
    theme,
    { task: "Verify tool card presentation and padding", agent: "task" },
    {
      content: [{ type: "text", text: "Subagents completed" }],
      details: {
        results: [
          {
            id: "explorer",
            agent: "scout",
            status: "completed",
            task: "Analyze card container structure",
            exitCode: 0,
          },
          {
            id: "verifier",
            agent: "specialist-tester",
            status: "completed",
            task: "Run full suite of regression tests",
            exitCode: 0,
          },
        ],
        totalDurationMs: 1420,
      },
    },
    { expanded: true },
    "demo:task",
  );
}

function renderHubDemo(theme: unknown): Container {
  return renderHubCard(
    theme,
    { op: "jobs" },
    {
      content: [{ type: "text", text: "Active jobs retrieved" }],
      details: {
        op: "jobs",
        jobs: [
          { id: "dev-server", status: "running", label: "Dev server on http://localhost:5173" },
          { id: "test-watcher", status: "idle", label: "Bun test watcher in background" },
        ],
        durationMs: 32,
      },
    },
    { expanded: true },
    "demo:hub",
  );
}

export function renderImageDemo(theme: unknown): Container {
  const groups = new GroupedToolManager({
    rowIsLive: () => false,
    activityLabel: () => "Reading inspect overlay preview",
    activityRunId: () => "demo:image",
    activityStartedAt: () => Date.now() - 42,
  });
  const frozen = {
    gid: "demo:image",
    label: "Reading inspect overlay preview",
  };
  const placeholderLines = renderImagePlaceholderBox(theme, 48, {
    mimeType: "image/webp",
    dimensions: "1231×788",
  });
  groups.renderToolVisual(
    theme,
    "demo:read:image",
    {
      body: "Read attachment://1",
      live: false,
      error: false,
      right: "(42ms)",
      details: placeholderLines,
    },
    frozen,
  );
  return groups.paintGroup(theme, "demo:image");
}

function renderTodoDemo(theme: unknown, width: number): readonly string[] {
  return renderDensityTodoHeader(
    theme,
    width,
    {
      items: [
        { label: "Investigate OMP tool execution background", status: "done", phase: "Diagnosis" },
        { label: "Wire inspect overlay hints", status: "open", phase: "Diagnosis" },
        { label: "Strip tool execution background tint", status: "done", phase: "Implementation" },
        { label: "Enforce 2-character padding", status: "done", phase: "Implementation" },
        { label: "Add automated interactive demo command", status: "active", phase: "Verification" },
        { label: "Blocked on host affordance", status: "blocked", phase: "Verification", note: "tool callback" },
        { label: "Dropped styling experiment", status: "dropped", phase: "Verification" },
      ],
      open: 2,
      done: 4,
      blocked: 1,
      activeLabel: "Add automated interactive demo command",
    },
    true,
  );
}
function renderSearchDemo(theme: unknown): Container {
  const groups = new GroupedToolManager({
    rowIsLive: () => false,
    activityLabel: () => "Searching for getArgumentCompletions implementations in pi-coding-agent",
    activityRunId: () => "demo:search",
    activityStartedAt: () => Date.now() - 600,
  });
  const frozen = {
    gid: "demo:search",
    label: "Searching for getArgumentCompletions implementations in pi-coding-agent",
  };
  const lines = formatSearchDetails(
    theme,
    [
      "# /home/redbull/.bun/install/cache/@oh-my-pi/pi-coding-agent@18.2.4@@@1/src/modes/",
      "## interactive-mode.ts#CDE3",
      ' 1290:                    icon: getSlashCommandTypeIcon("extension"),',
      " *1291:                    getArgumentCompletions: cmd.getArgumentCompletions,",
      " … 3 more lines",
      "",
      "## autocomplete.ts#C99C",
      " 182:",
      " *183:export interface AutocompleteItem {",
      " … 3 more lines",
    ],
    "getArgumentCompletions",
  );
  groups.renderToolVisual(
    theme,
    "demo:grep",
    {
      body: "Search `getArgumentCompletions:`",
      live: false,
      error: false,
      right: "(14ms)",
      details: lines,
    },
    frozen,
  );
  return groups.paintGroup(theme, "demo:search");
}
function renderThinkingDemo(theme: unknown, width: number): readonly string[] {
  const header = formatRowLine(theme, width, {
    body: "Reasoning over project architecture & card seams...",
    live: true,
    right: "(1.8s)",
  });
  const text = [
    "Analyzing terminal geometry and container hierarchy.",
    "Checking tool execution wrapper seams and theme background tokens.",
    "Enforcing 1-character padding and transparent row background.",
  ].join("\n");
  const rails = thinkingRailLines(theme, width, text);
  return [header, ...rails];
}

function renderWarningDemo(theme: unknown, width: number): readonly string[] {
  const icon = warningIconFrame(theme);
  const prefix = "  ";
  const message = "2 incomplete todos remain before turn completion";
  const line = `${prefix}${icon} ${paintAt(theme, message, "warning", 0.9)}`;
  return [truncatePlain(line, width)];
}

export interface DemoOption {
  value: string;
  label: string;
  description: string;
}

export const DEMO_OPTIONS: readonly DemoOption[] = [
  { value: "all", label: "all", description: "Sequential tour of all cards and surfaces" },
  { value: "search", label: "search", description: "Code search (grep) with syntax highlighting and pattern emphasis" },
  { value: "grep", label: "grep", description: "Alias for code search (grep)" },
  { value: "image", label: "image", description: "Image read card with pleasing placeholder box and inspect hint" },
  { value: "grouped", label: "grouped", description: "Grouped tools tree (bash, read, grep) with continuation rails" },
  { value: "write", label: "write", description: "Interactive streaming Write card with latest-lines projection" },
  { value: "edit", label: "edit", description: "Edit card diff with line numbers and soft diff bands" },
  { value: "eval", label: "eval", description: "Code cell evaluation with output separator rule" },
  { value: "task", label: "task", description: "Subagent task hierarchy with status and durations" },
  { value: "hub", label: "hub", description: "Background processes and peer coordination status" },
  { value: "todo", label: "todo", description: "Todos checklist header with phase grouping and progress" },
  { value: "thinking", label: "thinking", description: "Reasoning stream with live pulse and vertical rail" },
  { value: "warning", label: "warning", description: "One-line pulsing alert banner" },
  { value: "web_search", label: "web_search", description: "Web search query and ranked source results" },
  { value: "stop", label: "stop", description: "Dismiss the currently active demo widget" },
  { value: "help", label: "help", description: "List all available demo targets and descriptions" },
] as const;

export type DemoTarget =
  | "all"
  | "write"
  | "edit"
  | "eval"
  | "grouped"
  | "grep"
  | "search"
  | "image"
  | "images"
  | "img"
  | "web_search"
  | "task"
  | "hub"
  | "todo"
  | "todos"
  | "thinking"
  | "think"
  | "warning"
  | "alert"
  | "stop"
  | "help"
  | "list";

export async function runPluginDemo(ctx: ExtensionContext, rawTarget?: string): Promise<void> {
  if (!ctx.hasUI) return;

  const cleaned = rawTarget?.trim().toLowerCase();
  const clearDemo = () => {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    if (typeof ctx.ui.requestRender === "function") ctx.ui.requestRender();
  };

  if (cleaned === "help" || cleaned === "list" || cleaned === "options" || cleaned === "?") {
    clearDemo();
    const list = DEMO_OPTIONS.filter((o) => o.value !== "help")
      .map((opt) => `  ${opt.value.padEnd(12)} - ${opt.description}`)
      .join("\n");
    ctx.ui.notify(`Available /demo targets:\n${list}`, "info");
    return;
  }

  const validValues = new Set<string>([
    ...DEMO_OPTIONS.map((o) => o.value),
    "todos",
    "search",
    "think",
    "alert",
    "options",
    "?",
  ]);

  if (cleaned && !validValues.has(cleaned)) {
    clearDemo();
    const validList = DEMO_OPTIONS.filter((o) => o.value !== "help")
      .map((o) => o.value)
      .join(", ");
    ctx.ui.notify(`Unknown demo target "${rawTarget}". Available targets: ${validList}`, "warning");
    return;
  }

  const target = (cleaned || "all") as DemoTarget;
  const currentSeq = ++activeDemoSeq;

  const setDemoComponent = (factory: (tui: unknown, theme: unknown) => unknown) => {
    if (currentSeq !== activeDemoSeq) return;
    ctx.ui.setWidget(WIDGET_KEY, factory as never, { placement: "above-editor" });
    if (typeof ctx.ui.requestRender === "function") ctx.ui.requestRender();
  };

  if (target === "stop") {
    clearDemo();
    ctx.ui.notify("Demo dismissed", "info");
    return;
  }

  // --- Single Feature Demonstrations ---
  if (target === "write") {
    ctx.ui.notify("Demo: Write card streaming...", "info");
    for (let count = 1; count <= DEMO_WRITE_LINES.length; count += 1) {
      if (currentSeq !== activeDemoSeq) return;
      const partialContent = DEMO_WRITE_LINES.slice(0, count).join("\n");
      const isLast = count === DEMO_WRITE_LINES.length;
      setDemoComponent((_tui, theme) =>
        renderWriteCard(
          theme,
          { path: "src/server.ts", content: partialContent },
          isLast ? "ok" : undefined,
          { isPartial: !isLast },
          "demo:write:stream",
        ),
      );
      await sleep(75, currentSeq);
    }
    await sleep(2500, currentSeq);
    if (currentSeq !== activeDemoSeq) return;
    clearDemo();
    ctx.ui.notify("Demo: Write card finished", "info");
    return;
  }

  if (target === "edit") {
    ctx.ui.notify("Demo: Edit card diff", "info");
    setDemoComponent((_tui, theme) => renderEditDemo(theme));
    await sleep(3500, currentSeq);
    if (currentSeq !== activeDemoSeq) return;
    clearDemo();
    return;
  }

  if (target === "eval") {
    ctx.ui.notify("Demo: Eval code & execution output", "info");
    setDemoComponent((_tui, theme) => renderEvalDemo(theme));
    await sleep(3500, currentSeq);
    if (currentSeq !== activeDemoSeq) return;
    clearDemo();
    return;
  }

  if (target === "grouped") {
    ctx.ui.notify("Demo: Grouped tools & continuation rails", "info");
    setDemoComponent((_tui, theme) => renderGroupedDemo(theme));
    await sleep(3500, currentSeq);
    if (currentSeq !== activeDemoSeq) return;
    clearDemo();
    return;
  }

  if (target === "image" || target === "images" || target === "img") {
    ctx.ui.notify("Demo: Image card placeholder & inspect hint", "info");
    setDemoComponent((_tui, theme) => renderImageDemo(theme));
    await sleep(3500, currentSeq);
    if (currentSeq !== activeDemoSeq) return;
    clearDemo();
    return;
  }
  if (target === "search" || target === "grep") {
    ctx.ui.notify("Demo: Code search (grep) with syntax highlighting", "info");
    setDemoComponent((_tui, theme) => renderSearchDemo(theme));
    await sleep(3500, currentSeq);
    if (currentSeq !== activeDemoSeq) return;
    clearDemo();
    return;
  }

  if (target === "web_search" || target === "web") {
    ctx.ui.notify("Demo: Web Search card", "info");
    setDemoComponent((_tui, theme) => renderWebSearchDemo(theme));
    await sleep(3500, currentSeq);
    if (currentSeq !== activeDemoSeq) return;
    clearDemo();
    return;
  }

  if (target === "task") {
    ctx.ui.notify("Demo: Task subagents card", "info");
    setDemoComponent((_tui, theme) => renderTaskDemo(theme));
    await sleep(3500, currentSeq);
    if (currentSeq !== activeDemoSeq) return;
    clearDemo();
    return;
  }

  if (target === "hub") {
    ctx.ui.notify("Demo: Hub jobs & peers card", "info");
    setDemoComponent((_tui, theme) => renderHubDemo(theme));
    await sleep(3500, currentSeq);
    if (currentSeq !== activeDemoSeq) return;
    clearDemo();
    return;
  }

  if (target === "todo" || target === "todos") {
    ctx.ui.notify("Demo: Todos widget & checklist header", "info");
    setDemoComponent((_tui, theme) => {
      const container = new Container();
      container.addChild({
        render: (width: number) => renderTodoDemo(theme, width),
      });
      return container;
    });
    await sleep(3500, currentSeq);
    if (currentSeq !== activeDemoSeq) return;
    clearDemo();
    return;
  }

  if (target === "thinking" || target === "think") {
    ctx.ui.notify("Demo: Reasoning stream & vertical rail", "info");
    setDemoComponent((_tui, theme) => {
      const container = new Container();
      container.addChild({
        render: (width: number) => renderThinkingDemo(theme, width),
      });
      return container;
    });
    await sleep(3500, currentSeq);
    if (currentSeq !== activeDemoSeq) return;
    clearDemo();
    return;
  }

  if (target === "warning" || target === "alert") {
    ctx.ui.notify("Demo: Warning alert banner", "info");
    setDemoComponent((_tui, theme) => {
      const container = new Container();
      container.addChild({
        render: (width: number) => renderWarningDemo(theme, width),
      });
      return container;
    });
    await sleep(3500, currentSeq);
    if (currentSeq !== activeDemoSeq) return;
    clearDemo();
    return;
  }

  // --- Full Sequential Showcase Tour ("all") ---
  ctx.ui.notify("Running full minimal-output demo tour...", "info");

  // Step 1: Thinking stream
  if (currentSeq !== activeDemoSeq) return;
  ctx.ui.notify("[1/8] Reasoning Stream & Pulse Header", "info");
  setDemoComponent((_tui, theme) => {
    const container = new Container();
    container.addChild({
      render: (width: number) => renderThinkingDemo(theme, width),
    });
    return container;
  });
  await sleep(2200, currentSeq);
  if (currentSeq !== activeDemoSeq) return;

  // Step 2: Grouped tools (bash, read, grep)
  if (currentSeq !== activeDemoSeq) return;
  ctx.ui.notify("[2/9] Grouped Tools & Continuation Rails", "info");
  setDemoComponent((_tui, theme) => renderGroupedDemo(theme));
  await sleep(2200, currentSeq);
  if (currentSeq !== activeDemoSeq) return;

  // Step 3: Image read card placeholder & inspect hint
  if (currentSeq !== activeDemoSeq) return;
  ctx.ui.notify("[3/9] Image Card Placeholder & Inspect Hint", "info");
  setDemoComponent((_tui, theme) => renderImageDemo(theme));
  await sleep(2200, currentSeq);
  if (currentSeq !== activeDemoSeq) return;

  // Step 3: Code search (grep) with syntax highlighting
  if (currentSeq !== activeDemoSeq) return;
  ctx.ui.notify("[4/9] Code Search (grep) with Syntax Highlighting", "info");
  setDemoComponent((_tui, theme) => renderSearchDemo(theme));
  await sleep(2200, currentSeq);
  if (currentSeq !== activeDemoSeq) return;

  // Step 4: Write card streaming
  if (currentSeq !== activeDemoSeq) return;
  ctx.ui.notify("[5/9] Streaming Write Card", "info");
  for (let count = 1; count <= DEMO_WRITE_LINES.length; count += 2) {
    if (currentSeq !== activeDemoSeq) return;
    const partialContent = DEMO_WRITE_LINES.slice(0, count).join("\n");
    const isLast = count >= DEMO_WRITE_LINES.length;
    setDemoComponent((_tui, theme) =>
      renderWriteCard(
        theme,
        { path: "src/server.ts", content: partialContent },
        isLast ? "ok" : undefined,
        { isPartial: !isLast },
        "demo:write:stream",
      ),
    );
    await sleep(50, currentSeq);
  }
  await sleep(1500, currentSeq);
  if (currentSeq !== activeDemoSeq) return;

  // Step 4: Edit card diff
  if (currentSeq !== activeDemoSeq) return;
  ctx.ui.notify("[6/9] Edit Card (Diff & Line Markers)", "info");
  setDemoComponent((_tui, theme) => renderEditDemo(theme));
  await sleep(2200, currentSeq);
  if (currentSeq !== activeDemoSeq) return;

  // Step 5: Eval card
  if (currentSeq !== activeDemoSeq) return;
  ctx.ui.notify("[7/9] Eval Card (Code & Execution Output)", "info");
  setDemoComponent((_tui, theme) => renderEvalDemo(theme));
  await sleep(2200, currentSeq);
  if (currentSeq !== activeDemoSeq) return;

  // Step 6: Task and Hub cards
  if (currentSeq !== activeDemoSeq) return;
  ctx.ui.notify("[8/9] Task & Hub Cards", "info");
  setDemoComponent((_tui, theme) => {
    const combined = new Container();
    combined.addChild(renderTaskDemo(theme));
    combined.addChild(renderHubDemo(theme));
    return combined;
  });
  await sleep(2200, currentSeq);
  if (currentSeq !== activeDemoSeq) return;

  // Step 7: Todos, Warning, and Web Search
  if (currentSeq !== activeDemoSeq) return;
  ctx.ui.notify("[9/9] Todos, Warning Banner & Search", "info");
  setDemoComponent((_tui, theme) => {
    const combined = new Container();
    combined.addChild({
      render: (width: number) => renderTodoDemo(theme, width),
    });
    combined.addChild({
      render: (width: number) => renderWarningDemo(theme, width),
    });
    combined.addChild(renderWebSearchDemo(theme));
    return combined;
  });
  await sleep(2200, currentSeq);
  if (currentSeq !== activeDemoSeq) return;

  clearDemo();
  ctx.ui.notify("Minimal output demo tour completed! (Run /demo <target> to inspect specific cards)", "info");
  return;
}
