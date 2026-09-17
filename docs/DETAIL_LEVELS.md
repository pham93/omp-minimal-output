# Detail Levels Specification

Status: implemented.

This document defines the configurable transcript-density contract implemented by `omp-minimal-output` for Minimal, Standard, and Detailed modes. Row budgets are enforced by `core/density.ts` and dispatched through `cards/card-registry.ts`.

## Goals

- Make transcript density predictable across every tool surface.
- Keep Standard useful without requiring Ctrl+O for routine work.
- Preserve a strict one-row Minimal mode.
- Preserve complete information in Detailed mode.
- Keep failures and omission counts visible at every bounded level.

## Settings

| Setting                   | Type                                    | Default      | Range    | Effect                                          |
| ------------------------- | --------------------------------------- | ------------ | -------- | ----------------------------------------------- |
| `detailLevel`             | `"minimal" \| "standard" \| "detailed"` | `"standard"` | enum     | Global transcript density                       |
| `standardMaxRows`         | number                                  | `3`          | `1..20`  | Total Standard rows for tools without output    |
| `standardOutputMaxRows`   | number                                  | `4`          | `1..30`  | Total Standard rows for tools with output       |
| `standardEditRowsPerFile` | number                                  | `10`         | `1..50`  | Diff/context rows retained for each edited file |
| `standardWriteMaxRows`    | number                                  | `10`         | `1..50`  | Total Standard rows retained for Write          |
| `detailedMaxRows`         | number                                  | `20`         | `1..100` | Maximum total rows in Detailed and Ctrl+O       |

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

- A row means one visible terminal row produced for one tool event or the sticky Todo widget.
- Status parents and tool headers count toward total-row limits.
- Generic omission summaries consume the final available row.
- An error row is never hidden. When a bounded card is full, the error replaces the final preview row rather than exceeding the cap.
- ANSI styling, wrapped terminal text, and hidden persistence metadata do not change the logical row budget.
- Running and settled cards use the same configured density. A settled card may replace live content but must not exceed its mode's cap.
- Generic grouped tool output is capped once, after counting parent headers, tool rows, and output rows. Trailing blank output rows do not count; interior blank rows do. Output continues beneath its tool rather than appearing as sibling tool branches.

Edit is the deliberate exception to a total-card cap in Standard mode:

- `standardEditRowsPerFile` applies independently to every file.
- The status parent, Edit header, and file header do not count against the per-file allowance.
- Context rows, changed rows, and hunk-separator rows count.
- If a file contains additional rows, its `… N more rows` summary follows the configured allowance and does not consume one of the retained diff rows.

Write keeps a total-card cap:

- `standardWriteMaxRows` includes the status parent, Write header, content preview, and omission summary.
- When content is omitted, the final available row is the omission summary.

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

- Edit uses `standardEditRowsPerFile` for each file.
- Write uses `standardWriteMaxRows` total rows.
- A tool with output uses `standardOutputMaxRows` total rows.
- A tool without output uses `standardMaxRows` total rows.

### Detailed

Detailed matches the Ctrl+O-expanded representation but is bounded by `detailedMaxRows` per card. With the default, each expanded card shows at most 20 total rows, including headers and the final omission or error row.

## Standard behavior by tool

| Tool             | Standard preview                                                                           | Limit source                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Bash             | Status, command, output head/tail, omission or error                                       | `standardOutputMaxRows` when stdout/stderr exists; otherwise `standardMaxRows` |
| Read             | Status, file/range header, content preview, omission or error                              | `standardOutputMaxRows`                                                        |
| Grep             | Status, pattern/count header, first matches, omission or error                             | `standardOutputMaxRows`                                                        |
| Glob             | Status, pattern/count header, first paths, omission or error                               | `standardOutputMaxRows`                                                        |
| Write            | Status, file/line-count header, latest content lines with `(...N previous lines)` hint     | `standardWriteMaxRows`                                                         |
| Edit             | Status, aggregate header, every file header, bounded diff rows per file, per-file omission | `standardEditRowsPerFile`                                                      |
| Eval             | Status, language/input header, input or output preview, omission or error                  | `standardOutputMaxRows`                                                        |
| Web Search       | Status, query/source-count header, first source title/URL, omission or error               | `webSearchMaxResults` sources inside the `standardOutputMaxRows` card cap      |
| Task             | Status, aggregate agent header, first agent rows, omission or error                        | `taskMaxAgents` items inside the Standard card cap; `detailedMaxRows` expanded |
| Hub              | Status, operation summary, first peer/job/message rows, omission or error                  | `hubMaxItems` items inside the Standard card cap; `detailedMaxRows` expanded   |
| Todo             | One summary row when collapsed; full retained list when expanded                           | Todo expand/collapse state                                                     |
| LSP / AST Grep / Debug | Status, header, bounded native rows, omission or error                                | `standardOutputMaxRows` via the generic native density projection             |
| Other MCP/native | Status, tool/target header, first result rows, omission or error                           | `standardOutputMaxRows` when output exists; otherwise `standardMaxRows`        |

Specialized renderers keep their existing visual grammar. Unsupported native cards use a generic bounded projection and must fail open to the native renderer if their state cannot be read safely.

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
   │ (...35 previous lines)
   36 │ export type DetailLevel =
   37 │   | "minimal"
   38 │   | "standard"
   39 │   | "detailed";
     ╰─ … 3 more lines
```

With the default `standardOutputMaxRows: 4`:

```text
◆ Finding references
╰─ Grep "detailLevel" · 6 hits
   config.ts:45 detailLevel: DetailLevel
   … 5 more hits
```

### Tool without output — Standard

With the default `standardMaxRows: 3`:

```text
◆ Updating configuration
╰─ Write config.ts
   42 lines written
```

## Ctrl+O

Ctrl+O is a temporary Detailed override bounded by `detailedMaxRows` (default 20, `1..100`):

| Configured mode | Normal display | Ctrl+O display                    |
| --------------- | -------------- | --------------------------------- |
| Minimal         | Minimal        | Detailed, `detailedMaxRows` rows  |
| Standard        | Standard       | Detailed, `detailedMaxRows` rows  |
| Detailed        | Detailed       | Detailed, `detailedMaxRows` rows  |

Leaving the override restores the configured mode. Ctrl+O does not rewrite `detailLevel` or any row-limit setting.

## Implementation boundaries

- Tool execution, schemas, approval policy, persisted provider messages, and result data remain unchanged.
- Density is a display-only projection over existing tool state.
- No compatibility aliases exist for deprecated setting names.
- Current `native*` settings continue to win: a selected native fallback bypasses plugin density rendering for that tool.
- Full result text remains retained or spilled exactly as before; Detailed mode and Ctrl+O never depend on the Standard preview.

- Density rendering dispatches through `cards/card-registry.ts`. When the plugin is disabled or a `native*` setting wins, the registry throws a native-fallback error and the host restores its own renderer; a returned-`undefined` component would hide the transcript instead.
- The five native surface skins (read-group, assistant commentary, native tool cards, warning, todo HUD) subscribe through one `core/container-interceptor.ts` hook. `/minimal-off` removes the subscribers; `/minimal-on` reinstalls them.