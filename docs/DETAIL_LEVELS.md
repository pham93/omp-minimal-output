# Detail Levels Specification

Status: implemented.

This document defines the configurable transcript-density contract implemented by `omp-minimal-output` for Minimal, Standard, and Detailed modes. Row budgets are enforced by `core/density.ts` and dispatched through `cards/card-registry.ts`.

## Goals

- Make transcript density predictable across every tool surface.
- Keep Standard useful without requiring Ctrl+O for routine work.
- Preserve a strict one-row Minimal mode.
- Preserve independently bounded input and output in Detailed mode.
- Keep failures and omission counts visible at every bounded level.

## Settings

| Setting                   | Type                                    | Default      | Range    | Effect                                                                       |
| ------------------------- | --------------------------------------- | ------------ | -------- | ---------------------------------------------------------------------------- |
| `detailLevel`             | `"minimal" \| "standard" \| "detailed"` | `"standard"` | enum     | Global transcript density                                                    |
| `standardMaxRows`         | number                                  | `3`          | `1..20`  | Input content lines; thinking lines and read-group entries                   |
| `standardOutputMaxRows`   | number                                  | `4`          | `1..30`  | Output content lines per tool, independent of input                          |
| `standardEditRowsPerFile` | number                                  | `10`         | `1..50`  | Diff/context content lines retained for each edited file                     |
| `standardWriteMaxRows`    | number                                  | `10`         | `1..50`  | Latest source content lines retained for Write                               |
| `detailedMaxRows`         | number                                  | `20`         | `1..100` | Content lines per section/file; complete structured items in Detailed/Ctrl+O |

Configuration example:

```json
{
  "detailLevel": "standard",
  "standardMaxRows": 3,
  "standardOutputMaxRows": 4,
  "standardEditRowsPerFile": 10,
  "standardWriteMaxRows": 10,
  "detailedMaxRows": 20
}
```

These settings belong in the existing plugin settings object in `~/.omp/plugins/omp-plugins.lock.json` or a project override. They are validated and clamped through the same configuration path as current plugin settings.

## Counting rules

- Tool budgets count content, not assembled card height. Status parents, tool/file headers, decorative separators, and omission hints are additional rows.
- Input and output have independent allowances; input cannot consume output space.
- Each grouped execution owns its output allowance. Later tool headers cannot be hidden by earlier output.
- Source/output blank lines count; existing trailing-blank handling is retained. ANSI styling and gutters do not consume content lines.
- Keep tool identity and failure indication visible. Error output is bounded separately, not substituted for the header.
- Omission counts describe omitted content lines or items, never chrome.
- Write retains the latest N source lines; its previous-lines hint is outside N.
- Edit applies its allowance per file in Standard and Detailed. Changed/context rows count; hunk separators, file headers and omission hints do not.
- Eval uses input and output allowances independently. Partial output retains the tail; settled output retains the head.
- Search, Task and Hub use their Standard item settings and `detailedMaxRows` complete items when expanded. A source title/URL pair or agent entry is not split by a second row cap.
- Native read groups count file entries, excluding the group header and omission hint.
- Generic native layouts have no reliable content boundary; Standard and Detailed retain native rendering instead of guessing header counts.
- Thinking retains its existing content window. Todo is outside this tool-budget change: its existing expanded total-row cap remains unchanged.

## Modes

### Minimal

Minimal always renders exactly one row. It combines the strongest available status label with the tool identity and compact outcome.

```text
◆ Updating Todo defaults — Edit 2 files +14/−5
```

```text
◆ Creating configuration — Write config.ts · 42 lines
```

Minimal ignores all Standard row settings.

### Standard

Standard is the default mode.

- Edit uses `standardEditRowsPerFile` content lines for each file.
- Write uses `standardWriteMaxRows` latest content lines.
- Input previews use `standardMaxRows`; output previews independently use `standardOutputMaxRows`.
- Structured cards use their explicit item settings instead of a combined card cap.

### Detailed

Detailed matches the Ctrl+O-expanded representation. `detailedMaxRows` bounds each input/output section and each Edit file independently; for Search, Task, Hub and read groups it selects complete items. Headers and hints are additional rows, so expanded tool cards can exceed 20 total terminal rows.

## Standard behavior by tool

| Tool                                  | Standard preview                                            | Limit source                                            |
| ------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| Bash                                  | Command header and bounded output per execution             | `standardOutputMaxRows`                                 |
| Read                                  | File/range header and content preview                       | `standardOutputMaxRows`                                 |
| Grep                                  | Pattern header and result text preview                      | `standardOutputMaxRows`                                 |
| Glob                                  | Pattern header and result text preview                      | `standardOutputMaxRows`                                 |
| Write                                 | Latest source lines with previous-lines hint                | `standardWriteMaxRows`                                  |
| Edit                                  | Every file header and bounded diff/context content per file | `standardEditRowsPerFile`                               |
| Eval                                  | Independent input and output previews                       | `standardMaxRows` input; `standardOutputMaxRows` output |
| Web Search                            | Complete source titles and URLs                             | `webSearchMaxResults` sources                           |
| Task                                  | Complete selected agent entries                             | `taskMaxAgents` agents                                  |
| Hub                                   | Complete selected peer/job/message entries                  | `hubMaxItems` items                                     |
| Native read group                     | Header and file entries                                     | `standardMaxRows` entries                               |
| Todo                                  | Existing collapsed/expanded widget behavior                 | Unchanged; expanded total-row cap                       |
| LSP / AST Grep / Debug / Other        | Collapsed summary as the card header, then bounded detail lines | `standardOutputMaxRows` output                          |

Specialized renderers keep their existing visual grammar. Tools with no dedicated layout (LSP, AST Grep, Debug, GitHub, Checkpoint, Rewind, Context notes, New context, Security scan, Memory edit, Retain, Recall, Reflect, Learn, Manage skill) share `cards/collapsed-tool-card.ts`: the collapsed one-liner becomes the header and its bounded detail lines follow on the card content column, so they no longer fall back to native rendering. Minimal keeps their existing single-row projection, and the matching `native<Name>` setting restores the host renderer.

## Representative layouts

### Edit — Standard

```text
◆ Updating Todo defaults
╰─ Edit 2 files                                           +14/−5
   ├─ index.ts                                            +8/−3
   │  177 │   | undefined;
   │  178 - let todosCollapsed = false;
   │  178 + let todosCollapsed = true;
   │  179 │ let todoHeaderState = null;
   │
   │       ··· 419 unchanged lines
   │
   │  599 │   todoSource = undefined;
   │  600 +   todosCollapsed = true;
   │  601 │   todoSessionVisible = false;
   │      ╰─ … 12 more rows
   │
   ╰─ README.md                                           +6/−2
      35  │ Provider-tagged commentary wins…
      36  │
      37  - The sticky Todo widget hydrates on session start…
      37  + The sticky Todo widget hydrates collapsed…
      38  │
      39  - Eight shadows delegate to native execution…
      39  + Eight shadows delegate to native execution…
      40  │
      41  - Generic tools settle into grouped rows…
      41  + Generic tools use configured detail levels…
         ╰─ … 4 more rows
```

### Write — Standard

With the default `standardWriteMaxRows: 10`, the latest content lines are visible while Write is running and after it settles, with a `(...N previous lines)` hint above the retained window:

```text
◆ Creating the detail-level configuration
╰─ Write config.ts                                        42 lines
   │ (...32 previous lines)
   33 │ export type DetailLevel =
   34 │   | "minimal"
   35 │   | "standard"
   36 │   | "detailed";
   37 │
   38 │ export const limits = {
   39 │   input: 3,
   40 │   output: 4,
   41 │   detailed: 20,
   42 │ };
```

With the default `standardOutputMaxRows: 4`:

```text
◆ Finding references
╰─ Grep "detailLevel" · 6 hits
   config.ts:45 detailLevel: DetailLevel
   config.ts:80 detailLevel: "standard"
   density.ts:15 return config.detailLevel
   density.ts:19 const level = effectiveDetailLevel(options)
   … 2 more lines
```

### Eval input and output — Standard

With `standardMaxRows: 3` and `standardOutputMaxRows: 4`, three input lines and four output lines fit independently. Parent/tool headers, the output separator, and both omission hints are additional rows. A running tool without output does not spend an output allowance.

## Ctrl+O

Ctrl+O is a temporary Detailed override using `detailedMaxRows` (default 20, `1..100`) per content section/file or complete structured item list:

| Configured mode | Normal display | Ctrl+O display                  |
| --------------- | -------------- | ------------------------------- |
| Minimal         | Minimal        | Detailed content/item allowance |
| Standard        | Standard       | Detailed content/item allowance |
| Detailed        | Detailed       | Detailed content/item allowance |

Leaving the override restores the configured mode. Ctrl+O does not rewrite `detailLevel` or any row-limit setting.

Per-card expand lives in `/inspect` (shortcut `ctrl+alt+i`): a fullscreen replica outlines one tool card and Enter toggles that card only. Inspect does not rewrite transcript scrollback and does not treat Ctrl+O as a global expand inside the overlay.

## Implementation boundaries

- Tool execution, schemas, approval policy, persisted provider messages, and result data remain unchanged.
- Density is a display-only projection over existing tool state.
- No compatibility aliases exist for deprecated setting names.
- Current `native*` settings continue to win: a selected native fallback bypasses plugin density rendering for that tool.
- Full result text remains retained or spilled exactly as before; Detailed mode and Ctrl+O never depend on the Standard preview.

- Density rendering dispatches through `cards/card-registry.ts`. When the plugin is disabled or a `native*` setting wins, the registry throws a native-fallback error and the host restores its own renderer; a returned-`undefined` component would hide the transcript instead.
- The five native surface skins (read-group, assistant commentary, native tool cards, warning, todo HUD) subscribe through one `core/container-interceptor.ts` hook. `/minimal-off` removes the subscribers; `/minimal-on` reinstalls them.
