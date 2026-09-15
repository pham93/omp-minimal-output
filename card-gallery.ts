// Deterministic visual fixtures for card renderers. This module has no plugin
// registration or timers; callers opt in by importing a fixture renderer.
import { Container } from "@oh-my-pi/pi-tui";
import { renderDebugCard } from "./debug-card.ts";
import { renderLspCard } from "./lsp-card.ts";
import { renderSearchCard, SEARCH_CARD_KIND } from "./search-card.ts";
import { renderWebSearchCard } from "./web-search-card.ts";
import { renderHubCard } from "./hub-card.ts";
import { renderTaskCard } from "./task-card.ts";

export const CARD_GALLERY_STATE = {
  running: "running",
  success: "success",
  error: "error",
  expanded: "expanded",
} as const;

export type CardGalleryState = (typeof CARD_GALLERY_STATE)[keyof typeof CARD_GALLERY_STATE];

export interface CardGalleryFixture {
  args: unknown;
  result: unknown;
  options: unknown;
  fingerprint: string;
}

export type CardGalleryFixtures = Record<CardGalleryState, CardGalleryFixture>;

export type CardGalleryRenderer = (theme: unknown, fixture: CardGalleryFixture) => Container;

export function renderCardGalleryFixture(
  renderer: CardGalleryRenderer,
  theme: unknown,
  state: CardGalleryState,
  fixtures: CardGalleryFixtures,
): Container {
  return renderer(theme, fixtures[state]);
}

const SAMPLE_SOURCES = [
  { title: "Oh My Pi documentation", url: "https://ohmy-pi.dev/docs" },
  { title: "Provider API reference", url: "https://provider.example/api" },
  { title: "Search result three", url: "https://example.test/three" },
  { title: "Search result four", url: "https://example.test/four" },
  { title: "Search result five", url: "https://example.test/five" },
  { title: "Search result six", url: "https://example.test/six" },
] as const;

export const WEB_SEARCH_GALLERY_FIXTURES = {
  [CARD_GALLERY_STATE.running]: {
    args: { query: "card gallery" },
    result: undefined,
    options: { isPartial: true },
    fingerprint: "card-gallery:web_search:running",
  },
  [CARD_GALLERY_STATE.success]: {
    args: { query: "card gallery" },
    result: {
      content: [{ type: "text", text: "Search completed" }],
      details: { response: { provider: "gallery", sources: SAMPLE_SOURCES.slice(0, 2) } },
    },
    options: {},
    fingerprint: "card-gallery:web_search:success",
  },
  [CARD_GALLERY_STATE.error]: {
    args: { query: "card gallery" },
    result: {
      isError: true,
      content: [{ type: "text", text: "Search failed" }],
      details: { error: "Gallery search failure", response: { provider: "gallery", sources: [] } },
    },
    options: { expanded: true },
    fingerprint: "card-gallery:web_search:error",
  },
  [CARD_GALLERY_STATE.expanded]: {
    args: { query: "card gallery" },
    result: {
      content: [{ type: "text", text: "Search completed" }],
      details: { response: { provider: "gallery", sources: SAMPLE_SOURCES } },
    },
    options: { expanded: true },
    fingerprint: "card-gallery:web_search:expanded",
  },
} as const satisfies CardGalleryFixtures;

function renderWebSearchGalleryFixture(theme: unknown, fixture: CardGalleryFixture): Container {
  return renderWebSearchCard(theme, fixture.args, fixture.result, fixture.options, fixture.fingerprint);
}

export function renderWebSearchGalleryCard(theme: unknown, state: CardGalleryState): Container {
  return renderCardGalleryFixture(renderWebSearchGalleryFixture, theme, state, WEB_SEARCH_GALLERY_FIXTURES);
}

const TASK_AGENTS = ["researcher", "implementer", "reviewer", "tester", "release"] as const;

function taskResults(count: number) {
  return TASK_AGENTS.slice(0, count).map((agent, index) => ({
    id: agent,
    agent: "sonic",
    task: `Task card fixture ${index + 1}`,
    status: "completed",
    output: `Completed ${agent} fixture`,
    outputPath: `artifact://task-${agent}`,
    exitCode: 0,
  }));
}

export const TASK_GALLERY_FIXTURES = {
  [CARD_GALLERY_STATE.running]: {
    args: { task: "Render the Task card", agent: "sonic", name: "implementer" },
    result: undefined,
    options: { isPartial: true },
    fingerprint: "card-gallery:task:running",
  },
  [CARD_GALLERY_STATE.success]: {
    args: { task: "Render the Task card", agent: "sonic", name: "implementer" },
    result: {
      content: [{ type: "text", text: "Task completed" }],
      details: { results: taskResults(1), totalDurationMs: 800, projectAgentsDir: "/tmp/gallery-agents" },
    },
    options: {},
    fingerprint: "card-gallery:task:success",
  },
  [CARD_GALLERY_STATE.error]: {
    args: { task: "Render the Task card", agent: "sonic", name: "implementer" },
    result: {
      isError: true,
      content: [{ type: "text", text: "Task failed" }],
      details: {
        results: [{ id: "implementer", task: "Render the Task card", status: "failed", error: "Patch target changed", exitCode: 1 }],
        totalDurationMs: 800,
        projectAgentsDir: "/tmp/gallery-agents",
      },
    },
    options: { expanded: true },
    fingerprint: "card-gallery:task:error",
  },
  [CARD_GALLERY_STATE.expanded]: {
    args: { tasks: TASK_AGENTS.map((agent) => ({ task: `Fixture ${agent}`, agent: "sonic" })), context: "gallery" },
    result: {
      content: [{ type: "text", text: "Tasks completed" }],
      details: { results: taskResults(5), totalDurationMs: 4800, projectAgentsDir: "/tmp/gallery-agents" },
    },
    options: { expanded: true },
    fingerprint: "card-gallery:task:expanded",
  },
} as const satisfies CardGalleryFixtures;

function renderTaskGalleryFixture(theme: unknown, fixture: CardGalleryFixture): Container {
  return renderTaskCard(theme, fixture.args, fixture.result, fixture.options, fixture.fingerprint);
}

export function renderTaskGalleryCard(theme: unknown, state: CardGalleryState): Container {
  return renderCardGalleryFixture(renderTaskGalleryFixture, theme, state, TASK_GALLERY_FIXTURES);
}

const HUB_JOBS = Array.from({ length: 6 }, (_, index) => ({
  id: `job-${index + 1}`,
  status: "completed",
  label: `Hub fixture ${index + 1}`,
}));

export const HUB_GALLERY_FIXTURES = {
  [CARD_GALLERY_STATE.running]: {
    args: { op: "send", to: "Reviewer", message: "Inspect the card." },
    result: undefined,
    options: { isPartial: true },
    fingerprint: "card-gallery:hub:running",
  },
  [CARD_GALLERY_STATE.success]: {
    args: { op: "list" },
    result: {
      content: [{ type: "text", text: "Peers listed" }],
      details: { op: "list", peers: [{ displayName: "Reviewer", status: "idle" }, { displayName: "Builder", status: "running" }] },
    },
    options: {},
    fingerprint: "card-gallery:hub:success",
  },
  [CARD_GALLERY_STATE.error]: {
    args: { op: "send", to: "Reviewer", message: "Inspect the card." },
    result: {
      isError: true,
      content: [{ type: "text", text: "Peer is unavailable" }],
      details: { op: "send", receipts: [{ to: "Reviewer", status: "failed", error: "Peer is unavailable" }] },
    },
    options: { expanded: true },
    fingerprint: "card-gallery:hub:error",
  },
  [CARD_GALLERY_STATE.expanded]: {
    args: { op: "jobs" },
    result: { content: [{ type: "text", text: "Jobs listed" }], details: { op: "jobs", jobs: HUB_JOBS } },
    options: { expanded: true },
    fingerprint: "card-gallery:hub:expanded",
  },
} as const satisfies CardGalleryFixtures;

function renderHubGalleryFixture(theme: unknown, fixture: CardGalleryFixture): Container {
  return renderHubCard(theme, fixture.args, fixture.result, fixture.options, fixture.fingerprint);
}

export function renderHubGalleryCard(theme: unknown, state: CardGalleryState): Container {
  return renderCardGalleryFixture(renderHubGalleryFixture, theme, state, HUB_GALLERY_FIXTURES);
}

function galleryTextResult(
  text: string,
  details: Record<string, unknown> = {},
  isError = false,
): unknown {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text }],
    details: { ...details, minimalFullText: text },
  };
}

const GREP_EXPANDED_TEXT = [
  "src/auth.ts:12:export function authenticate() {",
  "src/auth.ts:28:  return authenticateToken(token);",
  "src/session.ts:9:import { authenticate } from './auth';",
  "src/session.ts:33:  const user = authenticate(request);",
  "tests/auth.test.ts:18:describe('authenticate', () => {",
  "tests/auth.test.ts:24:  expect(authenticate()).toBeDefined();",
].join("\n");

export const GREP_GALLERY_FIXTURES = {
  [CARD_GALLERY_STATE.running]: {
    args: { pattern: "authenticate", path: "src/**/*.ts" },
    result: undefined,
    options: { isPartial: true },
    fingerprint: "card-gallery:grep:running",
  },
  [CARD_GALLERY_STATE.success]: {
    args: { pattern: "authenticate", path: "src/**/*.ts" },
    result: galleryTextResult("src/auth.ts:12:export function authenticate() {"),
    options: {},
    fingerprint: "card-gallery:grep:success",
  },
  [CARD_GALLERY_STATE.error]: {
    args: { pattern: "[", path: "src/**/*.ts" },
    result: galleryTextResult("Error: invalid pattern", { error: "Invalid regular expression" }, true),
    options: { expanded: true },
    fingerprint: "card-gallery:grep:error",
  },
  [CARD_GALLERY_STATE.expanded]: {
    args: { pattern: "authenticate", path: "src/**/*.ts" },
    result: galleryTextResult(GREP_EXPANDED_TEXT),
    options: { expanded: true },
    fingerprint: "card-gallery:grep:expanded",
  },
} as const satisfies CardGalleryFixtures;

function renderGrepGalleryFixture(theme: unknown, fixture: CardGalleryFixture): Container {
  return renderSearchCard(
    theme,
    SEARCH_CARD_KIND.grep,
    fixture.args,
    fixture.result,
    fixture.options,
    fixture.fingerprint,
  );
}

export function renderGrepGalleryCard(theme: unknown, state: CardGalleryState): Container {
  return renderCardGalleryFixture(renderGrepGalleryFixture, theme, state, GREP_GALLERY_FIXTURES);
}

const AST_GREP_TEXT = [
  "# index.ts#ABCD",
  "*44:import { renderSearchCard } from './search-card.ts';",
  "*89:return renderSearchCard(theme, kind, args, result, options);",
  "# card-gallery.ts#EF01",
  "*204:return renderSearchCard(theme, kind, args, result, options);",
].join("\n");

export const AST_GREP_GALLERY_FIXTURES = {
  [CARD_GALLERY_STATE.running]: {
    args: { pat: "renderSearchCard($$$ARGS)", path: "*.ts", lang: "typescript" },
    result: undefined,
    options: { isPartial: true },
    fingerprint: "card-gallery:ast-grep:running",
  },
  [CARD_GALLERY_STATE.success]: {
    args: { pat: "renderSearchCard($$$ARGS)", path: "index.ts", lang: "typescript" },
    result: galleryTextResult(AST_GREP_TEXT),
    options: {},
    fingerprint: "card-gallery:ast-grep:success",
  },
  [CARD_GALLERY_STATE.error]: {
    args: { pat: "function", path: "*.ts", lang: "typescript" },
    result: galleryTextResult("Parse issue: pattern is not a complete AST node", {}, true),
    options: { expanded: true },
    fingerprint: "card-gallery:ast-grep:error",
  },
  [CARD_GALLERY_STATE.expanded]: {
    args: { pat: "renderSearchCard($$$ARGS)", path: "*.ts", lang: "typescript" },
    result: galleryTextResult(AST_GREP_TEXT),
    options: { expanded: true },
    fingerprint: "card-gallery:ast-grep:expanded",
  },
} as const satisfies CardGalleryFixtures;

function renderAstGrepGalleryFixture(theme: unknown, fixture: CardGalleryFixture): Container {
  return renderSearchCard(
    theme,
    SEARCH_CARD_KIND.astGrep,
    fixture.args,
    fixture.result,
    fixture.options,
    fixture.fingerprint,
  );
}

export function renderAstGrepGalleryCard(theme: unknown, state: CardGalleryState): Container {
  return renderCardGalleryFixture(
    renderAstGrepGalleryFixture,
    theme,
    state,
    AST_GREP_GALLERY_FIXTURES,
  );
}

const LSP_REFERENCE_TEXT = [
  "# index.ts",
  "*45:import { renderSearchCard } from './search-card.ts';",
  "*89:return renderSearchCard(theme, kind, args, result, options);",
  "# card-gallery.ts",
  "*204:return renderSearchCard(theme, kind, args, result, options);",
].join("\n");

export const LSP_GALLERY_FIXTURES = {
  [CARD_GALLERY_STATE.running]: {
    args: { action: "references", file: "search-card.ts", line: 194, symbol: "renderSearchCard" },
    result: undefined,
    options: { isPartial: true },
    fingerprint: "card-gallery:lsp:running",
  },
  [CARD_GALLERY_STATE.success]: {
    args: { action: "references", file: "search-card.ts", line: 194, symbol: "renderSearchCard" },
    result: galleryTextResult(LSP_REFERENCE_TEXT),
    options: {},
    fingerprint: "card-gallery:lsp:success",
  },
  [CARD_GALLERY_STATE.error]: {
    args: { action: "references", file: "missing.ts", line: 1, symbol: "missing" },
    result: galleryTextResult("No language server found for this action", {}, true),
    options: { expanded: true },
    fingerprint: "card-gallery:lsp:error",
  },
  [CARD_GALLERY_STATE.expanded]: {
    args: { action: "references", file: "search-card.ts", line: 194, symbol: "renderSearchCard" },
    result: galleryTextResult(LSP_REFERENCE_TEXT),
    options: { expanded: true },
    fingerprint: "card-gallery:lsp:expanded",
  },
} as const satisfies CardGalleryFixtures;

function renderLspGalleryFixture(theme: unknown, fixture: CardGalleryFixture): Container {
  return renderLspCard(theme, fixture.args, fixture.result, fixture.options, fixture.fingerprint);
}

export function renderLspGalleryCard(theme: unknown, state: CardGalleryState): Container {
  return renderCardGalleryFixture(renderLspGalleryFixture, theme, state, LSP_GALLERY_FIXTURES);
}

const DEBUG_THREADS_TEXT = [
  "thread 1 — stopped at breakpoint",
  "thread 2 — running",
  "thread 3 — waiting",
  "thread 4 — sleeping",
  "thread 5 — running",
  "thread 6 — waiting",
].join("\n");

export const DEBUG_GALLERY_FIXTURES = {
  [CARD_GALLERY_STATE.running]: {
    args: { action: "launch", program: "./server" },
    result: undefined,
    options: { isPartial: true },
    fingerprint: "card-gallery:debug:running",
  },
  [CARD_GALLERY_STATE.success]: {
    args: { action: "sessions" },
    result: galleryTextResult("No debug sessions."),
    options: {},
    fingerprint: "card-gallery:debug:success",
  },
  [CARD_GALLERY_STATE.error]: {
    args: { action: "continue" },
    result: galleryTextResult("No active debug session", { error: "No active debug session" }, true),
    options: { expanded: true },
    fingerprint: "card-gallery:debug:error",
  },
  [CARD_GALLERY_STATE.expanded]: {
    args: { action: "threads" },
    result: galleryTextResult(DEBUG_THREADS_TEXT),
    options: { expanded: true },
    fingerprint: "card-gallery:debug:expanded",
  },
} as const satisfies CardGalleryFixtures;

function renderDebugGalleryFixture(theme: unknown, fixture: CardGalleryFixture): Container {
  return renderDebugCard(theme, fixture.args, fixture.result, fixture.options, fixture.fingerprint);
}

export function renderDebugGalleryCard(theme: unknown, state: CardGalleryState): Container {
  return renderCardGalleryFixture(renderDebugGalleryFixture, theme, state, DEBUG_GALLERY_FIXTURES);
}

export const CARD_GALLERY_CARD = {
  all: "all",
  astGrep: "ast-grep",
  debug: "debug",
  grep: "grep",
  hub: "hub",
  lsp: "lsp",
  task: "task",
  webSearch: "web-search",
} as const;

export type CardGalleryCard = (typeof CARD_GALLERY_CARD)[keyof typeof CARD_GALLERY_CARD];

type SingleGalleryCard = Exclude<CardGalleryCard, typeof CARD_GALLERY_CARD.all>;

const CARD_GALLERY_RENDERERS: Record<
  SingleGalleryCard,
  (theme: unknown, state: CardGalleryState) => Container
> = {
  [CARD_GALLERY_CARD.astGrep]: renderAstGrepGalleryCard,
  [CARD_GALLERY_CARD.debug]: renderDebugGalleryCard,
  [CARD_GALLERY_CARD.grep]: renderGrepGalleryCard,
  [CARD_GALLERY_CARD.hub]: renderHubGalleryCard,
  [CARD_GALLERY_CARD.lsp]: renderLspGalleryCard,
  [CARD_GALLERY_CARD.task]: renderTaskGalleryCard,
  [CARD_GALLERY_CARD.webSearch]: renderWebSearchGalleryCard,
};

export function isCardGalleryCard(value: unknown): value is CardGalleryCard {
  return typeof value === "string" && Object.values(CARD_GALLERY_CARD).includes(value as CardGalleryCard);
}

export function isCardGalleryState(value: unknown): value is CardGalleryState {
  return typeof value === "string" && Object.values(CARD_GALLERY_STATE).includes(value as CardGalleryState);
}

export function renderNamedCardGallery(
  theme: unknown,
  card: CardGalleryCard,
  state: CardGalleryState,
): Container {
  if (card !== CARD_GALLERY_CARD.all) return CARD_GALLERY_RENDERERS[card](theme, state);
  const gallery = new Container();
  const cards = Object.values(CARD_GALLERY_CARD).filter(
    (value): value is SingleGalleryCard => value !== CARD_GALLERY_CARD.all,
  );
  for (let index = 0; index < cards.length; index += 1) {
    const name = cards[index];
    if (!name) continue;
    if (index > 0) gallery.addChild({ render: () => [""] });
    gallery.addChild(CARD_GALLERY_RENDERERS[name](theme, state));
  }
  return gallery;
}
