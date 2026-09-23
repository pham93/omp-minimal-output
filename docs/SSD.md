# omp-minimal-output — Software System Design

Display-only output skin for `omp`. Same tools, same execution. Smaller rows.

> Usage stays in `README.md`. This file is design only.
> The implemented detail-level contract lives in [`DETAIL_LEVELS.md`](DETAIL_LEVELS.md).
> Examples live in [`EXAMPLES.md`](EXAMPLES.md).

## 1. Purpose and scope

`omp-minimal-output` repaints tool rows in the transcript:

- One settled row per tool call (`◆` one-liner + duration) dispatched by `CardRegistry`.
- `Ctrl+O` (`app.tools.expand`) reveals details globally. `/inspect` (`ctrl+alt+i`) outlines one replica card. No per-row click path — renderers are display-only.
- Live reasoning streams in the widget above the editor; `hideThinkingBlock: true` (default in `minimal-output.yml`) hides every thought surface: the native thinking block, the settled `Thought` row and its detail block, and the live widget's text. Spillovers go to `$TMPDIR/omp-minimal-*.log`.

Out of scope: changing what any tool does, its schema, approvals, or result data.

## 2. Goals / non-goals

| Goals                                   | Non-goals                          |
| --------------------------------------- | ---------------------------------- |
| Merge call + result into one row        | New tool behavior or parameters    |
| Keep collapsed rows scannable           | Raw output in the transcript       |
| Fail open to native renderer            | Custom approval or execution paths |
| One setting per card (`native*`, limit) | Global "render anything" DSL       |

## 3. Context

Two tool families, two skins:

- **8 shadows** (`bash`, `read`, `grep`, `glob`, `write`, `edit`, `eval`, `web_search`): re-registered with native schema, delegate via `ctx.invokeTool`, and dispatch all rendering through `CardRegistry`.
- **2 observed** (`task`, `hub`): stay native. `cards/native-tool-card-skin.ts` observes `ToolExecutionComponent` and projects state. Never copied schema, never replaced approval.

Plus chrome skins: read-group, warning, assistant-commentary, and todo HUD — all subscribed through one `ContainerInterceptor`. Todo rows are indented onto the card content column (`TODO_ROW_INDENT`) and use the host theme's checkbox glyphs per status (`todoStatusBox`; ASCII `[x]`/`[ ]`/`[!]`/`[-]` fallback) while the in-progress row keeps its indicator; a settling row holds one tick, then an SGR-9 line is revealed across its label (`TODO_STRIKE_HOLD_MS` + `TODO_STRIKE_REVEAL_MS`, inside the same `TODO_DONE_ANIM_MS` window the pump already tracks). Both hook widgets carry flags (`isThinkingWidget`/`isTodosWidget`) so `ensureThinkingBeforeTodos` can re-assert the stack order — thinking block, then todos, then the working status row — after the host rebuilds its hook container on every `setWidget`. Registration order is the primary mechanism: the host appends hook widgets in Map order, so the first registered widget is topmost, and the two mount paths that register both (`/minimal-on`, `session_switch`) register thinking first. The render-time re-assertion is the safety net, and it reorders through a fresh child array plus `Container.invalidate()` rather than splicing in place, because the host's render loop captures the child array and its length before iterating.

## 4. Architecture

```mermaid
flowchart TD
    IDX["index.ts"]
    subgraph core["core/"]
        WRAP["tool-wrapper"]
        TRACK["activity-tracker"]
        PUMP["animation-pump"]
        INTER["container-interceptor"]
        CFG["config"]
        FILT["filters"]
    end
    subgraph cards["cards/"]
        REG["card-registry"]
        GROUP["grouped-tool-card"]
        WRITE["write-card"]
        EDIT["edit-card"]
        EVAL["eval-card"]
        WEB["web-search-card"]
        TASK["task-card"]
        HUB["hub-card"]
        SKIN["native-tool-card-skin"]
    end
    IDX --> WRAP
    WRAP --> REG
    REG --> GROUP
    REG --> WRITE & EDIT & EVAL & WEB
    SKIN --> TASK & HUB
    IDX --> INTER
    INTER --> SKIN
    IDX <--> CORE["omp core"]
```

`index.ts` owns wiring only. `core/tool-wrapper.ts` wraps tools and delegates rendering to `CardRegistry`; the registry dispatches grouped (`bash`/`read`/`grep`/`glob`) and dedicated adapters through one `render(context)` interface. Cards own meaning; `cards/card-primitives.ts` owns mechanics; `core/theme.ts` owns paint.

## 5. Runtime

### 5.1 Wrapped tool lifecycle

```mermaid
sequenceDiagram
    participant Core as omp core
    participant Reg as CardRegistry
    participant Collapse as collapse
    Core->>Reg: renderCall: live row
    Reg->>Core: execute native (ctx.invokeTool)
    Core->>Collapse: tool_result
    Collapse->>Core: one-liner + stash
    Core->>Reg: renderResult: settled
    Note over Core,Reg: Ctrl+O expands
```

Live rows pulse `◈ → ◉ → ◎ → ○` at 120 ms. Every settled row takes its mark from the `indicator` setting (`◆` for `diamond`, `●` for `dot`, none for `none`) — grouped tools, Task, Hub and web-search included. No card hardcodes a mark. Detail rows and child blocks share one content column (`CARD_CONTENT_PREFIX`), with `CARD_CONTINUATION_PREFIX` for a non-last grouped row. Errors use the error token. Thought and thinking rows (`formatSettledThought`, `thinkingRailLines`, `animatedThinkingRailLines`) are built from `cardDetailLine` via `thoughtRailLine`: one rail prefix (`THOUGHT_RAIL_PREFIX`) puts the rail on the card content column with the text one cell past it, and the `dim` token paints them at the configured `opacity`, with header rows (including the `Thought` and todo parent rows) at the `headerOpacity` setting — the animated widget passes its per-line fade as the row opacity, the commentary skin passes the live theme.

`CardRegistry.render` throws a native-fallback error when the plugin is disabled, a `native*` setting wins, or an adapter throws; OMP's host renderer catches construction/deferred errors and restores native output. Returning a falsy component would instead suppress the transcript, so the registry never does that. Renderers are resolved when a row is built: live rows re-style on the next frame after `/minimal-on`, but rows constructed while the plugin was off keep native rendering until the transcript is rebuilt (`/reload`, `/resume`, restart) — the accompanying `Tool renderer failed … native rendering required` warning is that expected signal.

### 5.2 Task / Hub observed path

```mermaid
flowchart TD
    N["native Task/Hub"]
    N --> C["ToolExecution"]
    C --> S["match callId?"]
    S -->|yes| K["task/hub card"]
    S -->|no| F["native render"]
```

Match keys: exact `toolCallId` identity first, then `isTaskCardData` / `isHubCardData` shape checks. Anything uncertain renders native.

### 5.3 Collapse pipeline (`core/filters.ts`)

```mermaid
flowchart TD
    IN["tool_result"] --> A["strip ANSI"]
    A --> P{"tool?"}
    P --> B["bash"]
    P --> R["read/write"]
    P --> S["grep/glob/lsp"]
    P --> K["other"]
    B --> C{"class?"}
    C --> T1["test/build"]
    C --> T2["git/other"]
    T1 --> T{"over 12k chars, 200 lines?"}
    T2 --> T
    R --> T
    S --> T
    K --> T
    T -->|yes| SP["spill TMPDIR"]
    T -->|no| OUT["one-liner"]
```

Contract: line 1 is always the collapsed row. Dedicated cards (`write`, `edit`, `eval`, `web_search`, Task, Hub) expand from stashed text or structured native details, not the one-liner. Content is selected before headers and hints are rendered; `detailedMaxRows` applies per input/output section or Edit file, and to complete item counts for structured cards.

## 6. Card catalog

| Card       | Collapsed                                    | Expanded                                            | Limit                                         |
| ---------- | -------------------------------------------- | --------------------------------------------------- | --------------------------------------------- |
| Bash test  | `◆ bash \`cmd\` — Tests: P passed, F failed` | failure lines + summary                             | spill cap                                     |
| Bash build | `◆ bash \`cmd\` — E errors, W warnings`      | error lines + head/tail                             | spill cap                                     |
| Bash git   | `◆ git sub — stat`                           | kept lines                                          | spill cap                                     |
| Read       | `◆ Read path`                                | bounded content preview                             | `detailedMaxRows`                             |
| Write      | `◆ Write path — N lines`                     | latest content lines + `(...N previous lines)` hint | `standardWriteMaxRows` / `detailedMaxRows`    |
| Grep       | `◆ Search \`pat\` — F files, H hits`         | bounded result text                                 | `detailedMaxRows` content                     |
| Glob       | `◆ Glob \`pat\` — N files`                   | bounded path list                                   | `detailedMaxRows`                             |
| Edit       | `Edit path — +a/−b`                          | bounded gutter diff, syntax-colored                 | `standardEditRowsPerFile` / `detailedMaxRows` |
| Eval       | `🐍 title / first line`                      | bounded input and output                            | `detailedMaxRows`                             |
| Web search | `Search \`q\` — N sources`                   | bounded bold titles + dim URLs                      | `webSearchMaxResults` / `detailedMaxRows`     |
| Task       | `Task N agents — completed`                  | bounded agent / status / result rows                | `taskMaxAgents` / `detailedMaxRows`           |
| Hub        | `Hub op target — summary`                    | bounded peer / job / message rows                   | `hubMaxItems` / `detailedMaxRows`             |
| Read group | `◆ Read N files`                             | bounded file list                                   | `detailedMaxRows`                             |

Tools without a dedicated layout — LSP, AST-grep, Debug, GitHub, Checkpoint, Rewind, Context notes, New context, Security scan, Memory edit, Retain, Recall, Reflect, Learn, Manage skill — are wrapped like every other tool and render through `cards/collapsed-tool-card.ts`: the collapsed one-liner from `core/filters.ts` becomes the card header (the plugin paints the configured `indicator` mark) and its bounded detail lines follow on the card content column. Their rows are the plugin's, not the host's; the matching `native<Name>` setting restores the host renderer. Dedicated running rows show the live indicator and elapsed time; error rows retain identity and bounded failure detail. See [`EXAMPLES.md`](EXAMPLES.md) for row shapes.

## 7. Config (`core/config.ts` + `package.json`)

| Setting                                               | Default           | Effect                                                                |
| ----------------------------------------------------- | ----------------- | --------------------------------------------------------------------- |
| `nativeBash/Read/Grep/Glob/Write/Edit/Eval/WebSearch` | `false`           | `true` restores native renderer per tool                              |
| `nativeTask`                                          | `false`           | `true` restores native Task, result text untouched                    |
| `taskMaxAgents`                                       | `4` (`1..8`)      | Standard Task item selection                                          |
| `nativeHub`                                           | `false`           | `true` restores native Hub                                            |
| `hubMaxItems`                                         | `5` (`1..10`)     | Standard Hub item selection                                           |
| `webSearchMaxResults`                                 | `5` (`1..10`)     | Standard source selection                                             |
| `detailedMaxRows`                                     | `20` (`1..100`)   | Detailed/Ctrl+O content per section/file or complete structured items |
| `indicator`                                           | `diamond`         | `◈◉◎○` live, `◆` settled                                              |
| `indicatorAnimation`                                  | `true`            | spin pump on/off                                                      |
| `opacity`                                             | `0.5`             | row dim blend                                                         |
| `detailLevel`                                         | `standard`        | minimal / standard / detailed density                                 |
| `standardMaxRows` / `standardOutputMaxRows`           | `3` / `4`         | Independent Standard input/output content allowances                  |
| `standardEditRowsPerFile` / `standardWriteMaxRows`    | `10` / `10`       | Per-file Edit content / latest Write content lines                    |
| `todosHeader` / `todoHud` / `todoReminderOneLine`     | `true/false/true` | todo chrome                                                           |
| `editShowTabs` / `editShowSpaces`                     | `true/false`      | whitespace glyphs in diff                                             |
| `composerRefreshInterval`                             | `60` (`1..3600`)  | composer status refresh polling seconds                               |

Source of truth: `~/.omp/plugins/omp-plugins.lock.json` + project overrides (`.omp/plugin-overrides.json`, `.pi/plugin-overrides.json`). Read live at render time; `turn_end` reloads on file mtime changes.

## 8. Safety

- Shadows forward the exact native `parameters` object. No hand-written schema.
- Wrapped tools declare a static approval class only where the host cannot infer it from the name (`glob`/`web_search`→read, `eval`→exec, and read-only tools without a layout: `lsp`, `ast_grep`, `security_scan`, `context_notes`, `recall`, `reflect`). Mutating tools without a layout (`debug`, `github`, `checkpoint`, `rewind`, `new_context`, `memory_edit`, `retain`, `learn`, `manage_skill`) keep the host's own policy for their unchanged name. `mcp__*` tools are never wrapped: their policy is per server, not per tool name.
- Task/Hub: no registration, no schema copy, no approval path. Hub's argument-dependent policy untouched.
- Registry and card renderers throw on failure; the host catch restores native rendering. Deferred render errors stay protected by the host's safe renderer.
- Control bytes (ESC, OSC, C0/C1) sanitized before paint. Width truncation is ANSI-aware.
- No row exceeds the width it was rendered at: a row that overflows wraps in the terminal while the host still counts it as one row, which shifts every row below it. When a row cannot hold its right-hand suffix (duration, `Ctrl+O` hint) plus at least one body cell, the suffix is dropped and the body keeps its cells — `formatRowLine` owns this, and `cardDetailLine`/`thoughtRailLine` build on it. `width-invariant.test.ts` sweeps every row producer across densities and widths 20–200 with hostile content.
- Grouped reads share one parent row; settled records freeze `label/total/runId` so rebuilds never mirror a later run.
- One `core/container-interceptor.ts` owns `Container.prototype.addChild`; skins register subscribers with idempotent cleanup and never overwrite another extension's hook.

## Appendix A. Files

| File                                                                           | Owns                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `index.ts`                                                                     | entry, wiring, skin installs, interceptor lifecycle           |
| `core/tool-wrapper.ts`                                                         | tool wrapping, native delegation, collapse hook               |
| `core/card-registry.ts` → `cards/card-registry.ts`                             | unified card dispatch (grouped + dedicated adapters)          |
| `core/container-interceptor.ts`                                                | single `addChild` seam, subscriber registry                   |
| `core/filters.ts`                                                              | pure collapse one-liners + truncation/spill                   |
| `cards/write-card.ts` / `edit-card.ts` / `eval-card.ts` / `web-search-card.ts` | wrapped-tool cards                                            |
| `cards/task-card.ts` / `cards/hub-card.ts`                                     | native-state projections                                      |
| `cards/native-tool-card-skin.ts`                                               | fail-open `ToolExecutionComponent` bridge                     |
| `cards/card-primitives.ts`                                                     | lifecycle, header, detail, error, limit helpers               |
| `core/theme.ts` / `core/text.ts` / `core/results.ts` / `core/loaders.ts`       | paint, labels, result readers, lazy core hooks                |
| `surfaces/read-group.ts` / `surfaces/warning-skin.ts` / `surfaces/todo-hud.ts` | group + alert + todo chrome                                   |
| `cards/card-gallery.ts`                                                        | deterministic fixtures (running / success / error / expanded) |
| `core/config.ts` / `package.json` / `minimal-output.yml`                       | settings, entry, host flags                                   |

## Appendix B. Glossary

- **Shadow**: re-registered tool with native schema that delegates execution and only changes rendering.
- **Observed**: native tool left registered; skin projects its component state.
- **One-liner**: collapsed row, line 1 of collapsed text.
- **Stash**: `details.minimalFullText`, full text saved pre-collapse for `Ctrl+O`.
- **Fail open**: any card error reaches the host catch, which restores the native transcript instead of hiding output.
