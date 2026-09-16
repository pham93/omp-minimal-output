# Engineering Guide

This file applies to the entire repository. It is the working agreement for every contributor and coding agent, regardless of seniority.

## Mission

`omp-minimal-output` is a Bun/TypeScript extension that changes how Oh My Pi renders tool activity and results. It must improve presentation without changing native tool behavior.

Optimize in this order:

1. Correctness and native behavior preservation.
2. Clear ownership and lifecycle safety.
3. Readability six months from now.
4. Performance in render and timer paths.
5. Visual polish.

Prefer boring, explicit code over clever abstractions. Make the smallest coherent change that solves the real problem.

## Project Map

- `index.ts`: extension registration, event orchestration, tool wrapping, and shared runtime state.
- `config.ts`: settings schema, defaults, validation, lockfile and project overrides.
- `card-primitives.ts`: shared card lifecycle and rendering mechanics.
- `*-card.ts`: tool-specific parsing and card presentation.
- `native-tool-card-skin.ts`: display skin for supported native tool cards.
- `filters.ts`: dependency-free output collapsing and diff parsing.
- `theme.ts`, `text.ts`, `density.ts`: row formatting, text helpers, and detail profiles.
- `results.ts`, `loaders.ts`: result identity, metadata, and lazy host affordances.
- `composer-shapes.ts`: prompt composer layouts.
- `todos-header.ts`, `todo-hud.ts`, `warning-skin.ts`: widget and alert surfaces.
- `runtime-owner.ts`: process-global ownership and hot-reload cleanup.
- `*.test.ts`: Bun behavior and regression tests, colocated at repository root.
- `package.json`: extension manifest, published files, and user-facing settings.
- `README.md`, `docs/`: public behavior and configuration documentation.

Keep orchestration in `index.ts`; move reusable formatting or parsing into the existing owning module. Do not create a second convention beside an established one.

## Non-Negotiable Contracts

- The extension is presentation-only. Do not alter tool arguments, results, schemas, approvals, execution order, or error semantics.
- A wrapped tool must delegate to the native implementation exactly once.
- Task and Hub remain native tools. Skin their public render lifecycle; never replace their schemas or approval logic.
- Custom renderers must fail open. If plugin rendering cannot run, preserve the native transcript instead of hiding output.
- Disabled and `native*` settings must restore native behavior completely.
- Persist settled-row identity and labels in message details. Historical rows must not read mutable state from a later run.
- Every timer, widget, prototype patch, listener, and process-global lease must have deterministic cleanup for disable and hot reload.
- Preserve ANSI-aware width, truncation, narrow-terminal behavior, and control-character sanitization.
- Never produce duplicate activity rows, cards, or widgets for one execution.
- Keep spill-file and truncation behavior intact for large output.

If a requested design conflicts with one of these contracts, document the conflict and choose the behavior-preserving design.

## Working Method

1. Read the affected module, adjacent helpers, and relevant tests before editing.
2. Trace registrations, configuration, and every call site affected by a public symbol change.
3. State the observable contract: running, partial, settled, expanded, error, disabled, and reload behavior as applicable.
4. Implement the smallest end-to-end change. Avoid opportunistic refactors.
5. Verify the narrow behavior first, then the full test suite.
6. Update settings metadata and documentation in the same change when public behavior changes.
7. Remove obsolete branches, comments, aliases, and temporary probes before review.

Do not suppress a symptom with a special case when the source invariant can be fixed.

## TypeScript Standards

- Use ESM and explicit `.ts` extensions for local imports.
- Follow `.prettierrc.json`: 2 spaces, semicolons, double quotes, trailing commas, 120-column width.
- Use `unknown` at external boundaries and narrow it with explicit guards. Avoid `any` and broad assertions.
- Prefer literal constants, discriminated unions, and exhaustive state handling over magic strings or boolean combinations.
- Default to `const`; use `readonly` for inputs and collections that must not mutate.
- Keep functions small and single-purpose. Use early returns to make invalid or inactive states obvious.
- Keep parsing pure where possible. Side effects belong at registration and lifecycle boundaries.
- Comments explain constraints, ownership, or non-obvious host behavior—not what the syntax already says.
- Reuse existing text, width, theme, lifecycle, result, and density helpers before adding new helpers.
- Do not add dependencies for behavior that can be expressed clearly with the platform or existing utilities.

### Render-Path Performance

Rendering and animation code is hot code:

- Do not perform avoidable I/O, imports, allocations, JSON parsing, or repeated full-text scans during `render()`.
- Hoist stable regular expressions and constants.
- Cache only with explicit invalidation and clear ownership; stale UI is worse than recomputation.
- Do not start one timer per row. Use the existing managed pumps and stop them when no surface is live.
- Never block the event loop with synchronous work proportional to unbounded tool output.

## Card and TUI Changes

- Use `card-primitives.ts` for shared lifecycle, headers, limits, errors, and parent labels.
- Keep tool-specific result parsing in the corresponding card module.
- Cover every relevant lifecycle state: running, partial, success, error, expanded, minimal, standard, and detailed.
- Preserve the established parent/child tree shape and settled indicators unless the task explicitly redesigns them.
- Treat terminal width as untrusted input. Test narrow widths and ANSI-colored content.
- Sanitize provider and tool text before displaying it; do not allow control sequences to corrupt terminal state.
- Preserve the literal tool intent and full result metadata even when the visible output is condensed.
- Do not make display code responsible for execution or approval decisions.

## Configuration Changes

A setting is incomplete unless all applicable surfaces are updated together:

1. `PluginConfig` type.
2. `DEFAULT_CONFIG`.
3. Overlay parsing, type validation, and numeric clamping in `config.ts`.
4. Boolean-key registration when applicable.
5. `package.json` under `pi.settings`.
6. Runtime use of the setting, including live reload behavior.
7. README or detail-level documentation.
8. Focused tests for defaults, valid values, invalid values, and bounds when the behavior is non-trivial.

Never silently accept malformed configuration. Ignore it safely and retain the documented default.

## Tests and Verification

Use Bun directly; this package currently defines no npm scripts.

```bash
bun test ./scrolling-text.test.ts
bun test
```

Replace the focused file with the test closest to the change.

Test observable behavior, not implementation plumbing:

- A regression test must fail for a plausible broken implementation.
- Assert visible rows, lifecycle transitions, precedence, bounds, cleanup, or real error behavior.
- Avoid assertions that merely copy fields, mirror mocks, or pin incidental source text.
- Keep tests deterministic. Use explicit timestamps instead of sleeping for animation behavior.
- When `mock.module()` must run before the module under test, keep the dynamic-import pattern used by existing tests.
- Reset mutable module or process-global state between tests.
- Strip ANSI only when color is irrelevant; otherwise assert color behavior deliberately.

For TUI changes, automated tests are not sufficient. Run the extension in OMP and observe the affected surface. Check, as applicable:

- Collapsed and expanded output.
- Running, success, and error states.
- Minimal, standard, and detailed density.
- Native fallback and disabled mode.
- Narrow terminal widths.
- Hot reload or repeated enable/disable.

Report exactly what was exercised. Do not claim visual verification from unit tests alone.

## Documentation and Packaging

- Update `README.md` for user-visible commands, defaults, settings, or behavior.
- Update `docs/DETAIL_LEVELS.md` when density semantics change.
- Update `package.json.files` when adding a runtime module required by the published extension.
- Keep examples aligned with current indicators, row shapes, and defaults.
- Do not add generated files, logs, spill files, or local configuration to the repository.

## Review Standard

Before requesting review, confirm:

- Native behavior and approvals are unchanged.
- All affected call sites and settings surfaces were migrated.
- Disabled, fallback, error, reload, and cleanup paths still work.
- Render code remains bounded and ANSI/width safe.
- No duplicate UI surface is introduced.
- Focused tests and `bun test` pass.
- Public documentation matches the implementation.
- The diff contains no unrelated formatting or speculative cleanup.

Reviews should identify the broken contract, cite the relevant code, and propose the smallest safe correction. Seniority does not override evidence; juniors should question unclear invariants, and seniors should make those invariants teachable.

## Agent and Tool Discipline

- Prefer repository-aware read, search, and glob tools over shell pipelines.
- Inspect exact file sections; do not open unrelated files hoping to find context.
- Before each tool call, write one short intent line.
- Use surgical edits for existing files and avoid destructive commands.
- Do not overwrite unrelated user work.
- Finish with changed files, exact verification commands, and any unverified risk.
