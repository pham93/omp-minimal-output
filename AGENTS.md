# omp-minimal-output — agent instructions

- Prefer read/grep/glob tools over shell pipelines; keep any shell one-liner short.
- One verification per change: typecheck or a single observed run, then report.
- Before each tool call, write one short intent line: `<Tool>: <plain-English goal>` (e.g. `Glob: looking for all TypeScript files`).
