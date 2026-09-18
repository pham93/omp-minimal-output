import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Container } from "@oh-my-pi/pi-tui";
import { renderWriteCard } from "../cards/write-card.ts";
import { renderPrettyEditCard } from "../cards/edit-card.ts";
import { renderEvalCard } from "../cards/eval-card.ts";
import { renderWebSearchCard } from "../cards/web-search-card.ts";
import { renderTaskCard } from "../cards/task-card.ts";
import { renderHubCard } from "../cards/hub-card.ts";
import { GroupedToolManager } from "../cards/grouped-tool-card.ts";
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
    "demo:bash",
    {
      body: "$ bun test",
      live: false,
      error: false,
      right: "(0.2s)",
      details: ["bun test v1.4.2 (744846f84)", "102 pass", "0 fail"],
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
      details: ["3 matches across 2 files"],
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

function renderTodoDemo(theme: unknown, width: number): readonly string[] {
  return renderDensityTodoHeader(
    theme,
    width,
    {
      summary: { total: 4, done: 3 },
      items: [
        { text: "Investigate OMP tool execution background", status: "completed", phase: "Diagnosis" },
        { text: "Strip tool execution background tint", status: "completed", phase: "Implementation" },
        { text: "Enforce 2-character padding", status: "completed", phase: "Implementation" },
        { text: "Add automated interactive demo command", status: "in_progress", phase: "Verification" },
      ],
    },
    true,
  );
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
    "Enforcing 2-character padding and transparent row background.",
  ].join("\n");
  const rails = thinkingRailLines(theme, width, text, false);
  return [header, ...rails];
}

function renderWarningDemo(theme: unknown, width: number): readonly string[] {
  const icon = warningIconFrame(theme);
  const prefix = "  ";
  const message = "2 incomplete todos remain before turn completion";
  const line = `${prefix}${icon} ${paintAt(theme, message, "warning", 0.9)}`;
  return [truncatePlain(line, width)];
}

export type DemoTarget =
  | "all"
  | "write"
  | "edit"
  | "eval"
  | "grouped"
  | "web_search"
  | "search"
  | "task"
  | "hub"
  | "todo"
  | "todos"
  | "thinking"
  | "think"
  | "warning"
  | "alert"
  | "stop";
export async function runPluginDemo(ctx: ExtensionContext, rawTarget?: string): Promise<void> {
  if (!ctx.hasUI) return;

  const target = (rawTarget?.trim().toLowerCase() || "all") as DemoTarget;
  const currentSeq = ++activeDemoSeq;

  const setDemoComponent = (factory: (tui: unknown, theme: unknown) => unknown) => {
    if (currentSeq !== activeDemoSeq) return;
    ctx.ui.setWidget(WIDGET_KEY, factory as never, { placement: "above-editor" });
    if (typeof ctx.ui.requestRender === "function") ctx.ui.requestRender();
  };

  const clearDemo = () => {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
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

  if (target === "web_search" || target === "search") {
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
  ctx.ui.notify("[1/7] Reasoning Stream & Pulse Header", "info");
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
  ctx.ui.notify("[2/7] Grouped Tools & Continuation Rails", "info");
  setDemoComponent((_tui, theme) => renderGroupedDemo(theme));
  await sleep(2200, currentSeq);
  if (currentSeq !== activeDemoSeq) return;

  // Step 3: Write card streaming
  if (currentSeq !== activeDemoSeq) return;
  ctx.ui.notify("[3/7] Streaming Write Card", "info");
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
  ctx.ui.notify("[4/7] Edit Card (Diff & Line Markers)", "info");
  setDemoComponent((_tui, theme) => renderEditDemo(theme));
  await sleep(2200, currentSeq);
  if (currentSeq !== activeDemoSeq) return;

  // Step 5: Eval card
  if (currentSeq !== activeDemoSeq) return;
  ctx.ui.notify("[5/7] Eval Card (Code & Execution Output)", "info");
  setDemoComponent((_tui, theme) => renderEvalDemo(theme));
  await sleep(2200, currentSeq);
  if (currentSeq !== activeDemoSeq) return;

  // Step 6: Task and Hub cards
  if (currentSeq !== activeDemoSeq) return;
  ctx.ui.notify("[6/7] Task & Hub Cards", "info");
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
  ctx.ui.notify("[7/7] Todos, Warning Banner & Search", "info");
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

