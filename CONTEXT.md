# Domain Glossary: omp-minimal-output

Domain concepts and terms used across the codebase and architectural seams.

## Core Domain Concepts

### Tool Card
A presentation-only rendered container for a single tool call or result. `CardRegistry.render` dispatches a shared render context to grouped or dedicated adapters, mapping raw tool arguments and results into compact, ANSI-aware visual lines with lifecycle indicators. Adapter errors propagate to the host's native fallback; an undefined component would hide output.

### Grouped Tool Card
An indented tree view aggregating multiple sequential invocations of generic tools (`bash`, `read`, `grep`, `glob`) under a single parent status row with continuation rails and combined omission counters.

### Activity Tracker
The runtime state machine tracking active tool executions. Ranks intent sources (`generated` < `tool` < `commentary`), resolves parent-child card linkages, maintains live run durations, and persists activity labels into message details.

### Animation Pump
The managed 120ms ticker coordinating shared spin frames and requesting UI repaints while any card, alert, commentary, or widget is in an active or settling state. Detects host idle conditions and tears down timers deterministically.

### Tool Wrapper
The runtime interception layer that preserves native tool implementations, schemas, approvals, and execution semantics while delegating to minimal card renderers. Guarantees exactly one native execution pass per call.

### Container Interceptor
The single owner of `Container.prototype.addChild` interception. Read-group, assistant commentary, native tool, warning, and Todo skins register subscribers rather than prototype patches. Hooks run newest-first, preserve one native insertion, and fail open independently. Disable removes subscribers; enable reinstalls them; runtime replacement disposes the shared interceptor without overwriting another extension's hook.

### Thinking Widget
The animated streaming widget (`minimal-thinking`) positioned above the prompt editor, rendering live reasoning tokens via a bottom-to-top scrolling buffer (`TextScroller`).

### Todo Widget & HUD
The sticky prompt widget (`minimal-todos`) and status line HUD presenting parsed task phases, completion countdowns, and expand/collapse toggles synchronized with host session state.

### Composer Dock
Custom prompt chrome layouts (`Minimal Output · Bottom Dock`, `Top Dock`, and Grayscale variants) that frame editor inputs, Git status, provider quota usage, and the context gauge.
