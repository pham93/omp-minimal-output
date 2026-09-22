# omp-minimal-output — Example output

Schematic row shapes per card. Color/paint omitted — structure only; spacing and omission counts vary with content and terminal width.

> Design rationale lives in [`SSD.md`](SSD.md). The implemented detail-level contract lives in [`DETAIL_LEVELS.md`](DETAIL_LEVELS.md). Usage lives in [`../README.md`](../README.md).
> `◈◉◎○` = running spin. `◆` = settled row, painted with the configured `indicator` (diamond shown here; `dot` renders `●`, `none` renders no mark) — every card follows the setting, grouped tools included. Red = error.
> `Ctrl+O` toggles collapsed ↔ expanded globally; `/inspect` outlines one replica card. `detailedMaxRows` (default 20) counts content per section/file or complete structured items, excluding headers and hints. No per-row click.

## Bash

```text
◈ bash `bun test`                        1.2s
◆ bash `bun test` — Tests: 12 passed, 1 failed
  FAIL src/foo.test.ts
  expected 200, got 404
  Tests: 12 passed
```

```text
◆ bash `tsc -p .` — 2 errors, 1 warnings
  src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'
```

```text
◆ git status — 3 files changed
  M src/index.ts
  M src/theme.ts
  ?? docs/
```

```text
◆ bash `biome check .` — 3 problems
```

```text
◆ bash `ls -la` — done
```

## Read / Write

```text
◆ Read src/index.ts
◈ Write src/index.ts — 42 lines
    │ (...35 previous lines)
   36 │ export default function register(pi: ExtensionAPI) {
   37 │   // latest lines retained; window grows while streaming
   38 │ }
◆ Skill my-skill — SKILL.md
```

Write shows the latest content lines (`standardWriteMaxRows` in Standard) with a `(...N previous lines)` hint above and 1-based new-side gutter numbers; the syntax-highlighted preview appears while running because content is available in the tool call. Native Write does not emit incremental text chunks.

Grouped reads (native group skinned):

```text
◆ Read 3 files
  ├─ src/index.ts
  ├─ src/theme.ts
  ╰─ src/text.ts
```

```text
◆ Read src/index.ts
```

A single grouped read collapses to one row. Standard selects `standardMaxRows` file entries; Detailed/Ctrl+O select `detailedMaxRows` entries. The group header and `… N more files` summary are additional rows.

Grouped reads (native group skinned):

```text
◆ Read 3 files
  ├─ src/index.ts
  ├─ src/theme.ts
  ╰─ src/text.ts
```

## Grep / Glob / LSP

```text
◆ Search `TODO` — 2 files, 5 hits
  src/index.ts: 4 hits (first 3 shown)
  src/index.ts:12:3: // TODO: picks up
  src/theme.ts: 1 hits (first 1 shown)
  src/theme.ts:40:7: // TODO: token
```

```text
◆ Search `renderCall`
◆ Glob `src/**/*.ts` — 12 files
```

LSP, AST-grep, and Debug keep their native Standard/Detailed rendering. Their opaque rendered rows do not expose reliable input/output boundaries, so the plugin does not guess which rows are headers. These tools have no card: their rows come from the rewritten result text, so the leading `◆` is literal and does not follow the `indicator` setting.

```text
◆ Lsp references foo.ts — 8 results
  src/a.ts:12
  … 6 more rows
```

## Edit

Collapsed:

```text
◆ Edit src/foo.ts — +3/−1                       0.4s
```

Expanded (gutter = new-side number, `-`/`+` banded):

```text
◆ Edit src/foo.ts — +3/−1                       0.4s
    12  const limit = 4;
    13 -const name = "x";
    13 +const name = "y";
    14 +const extra = true;
```

Multi-file:

```text
◆ Edit 2 files — +10/−2
  src/a.ts — +8/−1
  src/b.ts — +2/−1
```

Error:

```text
◆ Edit src/foo.ts — failed
  error: patch target changed
```

## Eval

Collapsed (icon + title or first code line, 3 input / 5 output lines):

```text
◆ 🐍 inspect cards                            0.2s
  print(summary)
  ── output ─────────────────
  12 rows, 3 cards
```

Expanded (input 60, output 60):

```text
◆ 🐍 inspect cards                            0.2s
  for row in rows:
    print(row.label, row.state)
  … (4 more lines)
  ── output ─────────────────
  alpha ok
  beta ok
  … (18 more lines)
```

Error:

```text
◆ 🐍 inspect cards — failed
  ── error ──────────────────
  Traceback (most recent call last): ...
```

## Web search

Running:

```text
◈ Search `Oh My Pi coding agent`
```

Collapsed:

```text
◆ Search `Oh My Pi coding agent` — 3 sources      via gallery
```

Expanded (bounded by `webSearchMaxResults`, default 5):

```text
◆ Search `Oh My Pi coding agent` — 3 sources      via gallery
  ╰─ Oh My Pi documentation
     https://ohmy-pi.dev/docs
  ╰─ Provider API reference
     https://provider.example/api
```

Overflow / error:

```text
  ╰─ … 1 more source
◆ Search `Oh My Pi coding agent` — failed
  ╰─ Search request failed
```

## Task (observed native)

Running:

```text
◈ Task agent implementer — running                 1.2s
```

Collapsed:

```text
◆ Task 5 agents — completed                        4.8s
◆ Task 5 agents — mixed: 4 completed · 1 failed    5.1s
◆ Task agent implementer — failed                  0.8s
```

Expanded (bounded by `taskMaxAgents`, default 4):

```text
◆ Task 5 agents — completed                        4.8s
  ╰─ researcher — completed
     task: Task card fixture 1
     output: Completed researcher fixture
     artifact: artifact://task-researcher
  ╰─ … 1 more agent
```

Error row inside:

```text
  ╰─ implementer — failed
     task: Render the Task card
     error: Patch target changed
```

## Hub (observed native)

Collapsed:

```text
◆ Hub list — 2 peers
◆ Hub send Reviewer — 1 delivered
◆ Hub jobs — 6 jobs
◆ Hub send Reviewer — failed
```

Expanded (bounded by `hubMaxItems`, default 5):

```text
◆ Hub jobs — 6 jobs
  ╰─ job job-1 — completed
     Hub fixture 1
  ╰─ … 1 more item
```

Error:

```text
◆ Hub send Reviewer — failed
  ╰─ receipt Reviewer — failed
     Peer is unavailable
```

## Todo / warning chrome

Collapsed summary (hover/`ctrl+alt+t` expands):

```text
 ◆ ▸ Todos 2 open, 1 done — shipping SSD docs                             ▸ expand · Ctrl+Alt+T
 ⚠ 2 incomplete todos - reminder 1/5 ☐ Wire inspect overlay hints ☐ Ship the SSD docs
```

The `⚠` row pulses while it is the newest transcript block; as soon as anything follows it the block
finalizes, so the host commits the row to scrollback (static) instead of pinning the transcript and
dropping the head of later long answers.

Expanded widget: one checkbox per row — empty for pending (label color unchanged), checked for
settled, in-between for blocked (`[!]`/`☒`) and dropped (`[-]`/`⊟`) — while the in-progress row keeps
its `◐` indicator. Settled labels are struck through, revealed by an animated line when the item
settles.

```text
 ◆ ▾ Todos 2 open, 2 done, 1 blocked                  ▾ collapse · Ctrl+Alt+T
     Diagnosis
     ├─ [x] Investigate tool execution background
     ╰─ [ ] Wire inspect overlay hints
     Verification
     ├─ ◐ Add automated demo command
     ├─ [!] Blocked on host affordance — blocked: tool callback
     ╰─ [-] Dropped styling experiment (dropped)
```
