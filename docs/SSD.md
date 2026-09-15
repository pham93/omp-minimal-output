# omp-minimal-output — Software System Design

Display-only output skin for `omp`. Same tools, same execution. Smaller rows.

> Usage stays in `README.md`. This file is design only.
> The implemented detail-level contract lives in `DETAIL_LEVELS.md`.
> Examples live in `EXAMPLES.md`.

## 1. Purpose and scope

`omp-minimal-output` repaints tool rows in the transcript:

- One settled row per tool call (`◆` one-liner + duration).
- `Ctrl+O` (`app.tools.expand`) reveals details. No per-row click path — renderers are display-only.
- Thoughts hidden. Spillovers go to `$TMPDIR/omp-minimal-*.log`.

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

- **8 shadows** (`bash`, `read`, `grep`, `glob`, `write`, `edit`, `eval`, `web_search`): re-registered with native schema, delegate via `ctx.invokeTool`.
- **2 observed** (`task`, `hub`): stay native. `native-tool-card-skin.ts` observes `ToolExecutionComponent` and projects state. Never copied schema, never replaced approval.

Plus three chrome skins: read-group, warning, todo.

## 4. Architecture

```mermaid
flowchart TD
    %% entry
    IDX["index.ts"]
    %% cards
    IDX --> EDIT["edit-card"]
    IDX --> EVAL["eval-card"]
    IDX --> WEB["web-card"]
    IDX --> TASK["task-card"]
    IDX --> HUB["hub-card"]
    %% shared
    EDIT --> PRIM["primitives"]
    EVAL --> PRIM
    WEB --> PRIM
    TASK --> PRIM
    HUB --> PRIM
    PRIM --> THEME["theme"]
    IDX --> FILT["filters"]
    IDX --> CFG["config"]
    %% host
    IDX <--> CORE["omp core"]
```

`index.ts` owns wiring (`CARD_RENDERERS`, `tryWrapTool`, `collapseToolText`, skin installs).
Cards own meaning. `card-primitives.ts` owns mechanics. `theme.ts` owns paint.

## 5. Runtime

### 5.1 Wrapped tool lifecycle

```mermaid
sequenceDiagram
    participant Core as omp core
    participant Card as card
    participant Collapse as collapse
    Core->>Card: renderCall: live row
    Card->>Core: execute native
    Core->>Collapse: tool_result
    Collapse->>Core: one-liner + stash
    Core->>Card: renderResult: settled
    Note over Core,Card: Ctrl+O expands
```

Live rows pulse `◈ → ◉ → ◎ → ○` at 120 ms. Settled rows use the configured indicator (`◆` default); web search, Task, Hub settle to `●`. Errors use the error token.

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

### 5.3 Collapse pipeline (`filters.ts`)

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

Contract: line 1 is always the collapsed row. Dedicated cards (`write`, `edit`, `eval`, `web_search`, Task, Hub) expand from stashed text or structured native details, not the one-liner; `detailedMaxRows` caps each expanded card.

## 6. Card catalog

| Card       | Collapsed                                    | Expanded                                      | Limit             |
| ---------- | -------------------------------------------- | --------------------------------------------- | ----------------- |
| Bash test  | `◆ bash \`cmd\` — Tests: P passed, F failed` | failure lines + summary                       | spill cap         |
| Bash build | `◆ bash \`cmd\` — E errors, W warnings`      | error lines + head/tail                       | spill cap         |
| Bash git   | `◆ git sub — stat`                           | kept lines                                    | spill cap         |
| Read       | `◆ Read path`                                | bounded content preview                       | `detailedMaxRows` |
| Write      | `◆ Write path`                               | bounded live syntax-highlighted input preview | `detailedMaxRows` |
| Grep / LSP | `◆ Search \`pat\` — F files, H hits`         | bounded match groups                          | `detailedMaxRows` |
| Glob       | `◆ Glob \`pat\` — N files`                   | bounded path list                             | `detailedMaxRows` |
| Edit       | `Edit path — +a/−b`                          | bounded gutter diff, syntax-colored           | `detailedMaxRows` |
| Eval       | `🐍 title / first line`                      | bounded input and output                      | `detailedMaxRows` |
| Web search | `Search \`q\` — N sources`                   | bounded bold titles + dim URLs                | `detailedMaxRows` |
| Task       | `Task N agents — completed`                  | bounded agent / status / result rows          | `detailedMaxRows` |
| Hub        | `Hub op target — summary`                    | bounded peer / job / message rows             | `detailedMaxRows` |
| Read group | `◆ Read N files`                             | bounded file list                             | `detailedMaxRows` |

Running rows replace the summary with `running` + elapsed. Error rows keep the header and add red detail lines. See `EXAMPLES.md` for literal rows.

## 7. Config (`config.ts` + `package.json`)

| Setting                                               | Default           | Effect                                             |
| ----------------------------------------------------- | ----------------- | -------------------------------------------------- |
| `nativeBash/Read/Grep/Glob/Write/Edit/Eval/WebSearch` | `false`           | `true` restores native renderer per tool           |
| `nativeTask`                                          | `false`           | `true` restores native Task, result text untouched |
| `taskMaxAgents`                                       | `4` (`1..8`)      | Standard Task item selection                       |
| `nativeHub`                                           | `false`           | `true` restores native Hub                         |
| `hubMaxItems`                                         | `5` (`1..10`)     | Standard Hub item selection                        |
| `webSearchMaxResults`                                 | `5` (`1..10`)     | Standard source selection                          |
| `detailedMaxRows`                                     | `20` (`1..100`)   | Detailed and Ctrl+O total-row ceiling              |
| `indicator`                                           | `diamond`         | `◈◉◎○` live, `◆` settled                           |
| `indicatorAnimation`                                  | `true`            | spin pump on/off                                   |
| `opacity`                                             | `0.5`             | row dim blend                                      |
| `todosHeader` / `todoHud` / `todoReminderOneLine`     | `true/false/true` | todo chrome                                        |
| `editShowTabs` / `editShowSpaces`                     | `true/false`      | whitespace glyphs in diff                          |

Source of truth: `~/.omp/plugins/omp-plugins.lock.json` + project overrides. Read live at render time; no restart for most toggles.

## 8. Safety

- Shadows forward the exact native `parameters` object. No hand-written schema.
- Only static-approval tools are wrapped (`glob`→read, `eval`→exec, `web_search`→read). Dynamic-policy tools are never added.
- Task/Hub: no registration, no schema copy, no approval path. Hub's argument-dependent policy untouched.
- Every card renderer try/catches to a one-line fallback, then to native.
- Control bytes (ESC, OSC, C0/C1) sanitized before paint. Width truncation is ANSI-aware.
- Grouped reads share one parent row; settled records freeze `label/total/runId` so rebuilds never mirror a later run.

## Appendix A. Files

| File                                                                    | Owns                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `index.ts`                                                              | entry, `CARD_RENDERERS`, `tryWrapTool`, collapse hook, skin installs |
| `filters.ts`                                                            | pure collapse one-liners + truncation/spill                          |
| `edit-card.ts` / `eval-card.ts` / `web-search-card.ts`                  | wrapped-tool cards                                                   |
| `task-card.ts` / `hub-card.ts`                                          | native-state projections                                             |
| `native-tool-card-skin.ts`                                              | fail-open `ToolExecutionComponent` bridge                            |
| `card-primitives.ts`                                                    | lifecycle, header, detail, error, limit helpers                      |
| `theme.ts` / `text.ts` / `results.ts` / `loaders.ts`                    | paint, labels, result readers, lazy core hooks                       |
| `read-group.ts` / `warning-skin.ts` / `todos-header.ts` / `todo-hud.ts` | group + alert + todo chrome                                          |
| `card-gallery.ts`                                                       | deterministic fixtures (running / success / error / expanded)        |
| `config.ts` / `package.json` / `minimal-output.yml`                     | settings, entry, host flags                                          |

## Appendix B. Glossary

- **Shadow**: re-registered tool with native schema that delegates execution and only changes rendering.
- **Observed**: native tool left registered; skin projects its component state.
- **One-liner**: collapsed row, line 1 of collapsed text.
- **Stash**: `details.minimalFullText`, full text saved pre-collapse for `Ctrl+O`.
- **Fail open**: any card error renders native instead of breaking the transcript.
