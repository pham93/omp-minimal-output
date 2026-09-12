// Pure string filters for omp-minimal-output. Zero dependencies.
//
// Contract: line 1 of every rewritten text is the `◆` settled one-liner
// (the transcript's collapsed row); filtered details follow from line 2,
// so ENTER expands a row to details and collapses back to the one-liner.

export interface CollapseResult {
	text: string;
	changed: boolean;
	rule: string;
	/** Full ANSI-stripped source before truncation. Expanded rows read it. */
	fullText: string;
}

export const MAX_CHARS = 12000;
export const MAX_LINES = 200;

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ERROR_RE = /error|fail|✗|×|panic|assert|exception|traceback|denied|blocked/i;

function shortCommandText(cmd: string): string {
	const oneLine = cmd.replace(/\s+/g, " ").trim();
	if (!oneLine) return "bash";
	return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

export function isBuildCommand(cmd: string): boolean {
	return /(^|[\s;&|])(tsc|vite|webpack|rollup|esbuild|gradle|mvn|cmake|make|ninja)\b|(cargo build|go build|npm run build|bun run build|pnpm build|biome check)/i.test(
		cmd,
	);
}

export function isTestCommand(cmd: string): boolean {
	return /(vitest|jest|pytest|mocha|ava|tap|bun test|cargo test|go test|phpunit|rspec|\.test\.(ts|js|tsx|jsx|py|go|rb))/i.test(
		cmd,
	);
}

export function isGitCommand(cmd: string): boolean {
	return /^\s*git\b/.test(cmd);
}
export function isLinterCommand(cmd: string): boolean {
	return /(eslint|biome|ruff|flake8|clippy|tslint|stylelint|shellcheck)/i.test(cmd);
}

function parseTestCounts(text: string): { passed?: number; failed?: number } {
	const lines = text.split("\n");
	const scope = lines.find((l) => /^\s*tests?\s+\d+\s+passed/i.test(l)) ?? text;
	const both =
		scope.match(/(\d+)\s+passed[^\n]*?(\d+)\s+failed/i) ??
		scope.match(/(\d+)\s+failed[^\n]*?(\d+)\s+passed/i);
	if (both) {
		const first = Number(both[1]);
		const second = Number(both[2]);
		return /passed[^\n]*?failed/i.test(both[0])
			? { passed: first, failed: second }
			: { passed: second, failed: first };
	}
	const passed = scope.match(/(\d+)\s+passed/i);
	const failed = scope.match(/(\d+)\s+failed/i);
	return {
		passed: passed ? Number(passed[1]) : undefined,
		failed: failed ? Number(failed[1]) : undefined,
	};
}

function aggregateTestOutput(text: string, shortCmd: string): { oneLiner: string; details: string } {
	const lines = text.split("\n");
	const summary = lines.filter((l) => /tests?:|passed|failed/i.test(l)).slice(0, 5);
	const failures: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (/FAIL|✗|×|failed|panic|traceback|AssertionError/i.test(lines[i])) {
			failures.push(lines[i]);
			if (/^FAIL\s/.test(lines[i]) && i + 1 < lines.length && lines[i + 1].trim()) {
				failures.push(lines[i + 1]);
			}
		}
	}
	const { passed, failed } = parseTestCounts(text);
	const counts =
		passed !== undefined || failed !== undefined
			? `Tests: ${passed ?? 0} passed, ${failed ?? 0} failed`
			: "done";
	const details = [...failures, ...summary].filter((l, i, a) => l.trim() && a.indexOf(l) === i);
	return {
		oneLiner: `◆ ${shortCmd} — ${counts}`,
		details: details.join("\n"),
	};
}

function filterBuildOutput(text: string, shortCmd: string): { oneLiner: string; details: string } {
	const lines = text.split("\n");
	const problems = lines.filter((l) => ERROR_RE.test(l));
	const errors = problems.filter((l) => /error/i.test(l)).length;
	const warnings = problems.filter((l) => /warning/i.test(l)).length;
	const head = lines.slice(0, 5);
	const tail = lines.slice(-5);
	const details = [...head, ...problems, ...tail].filter((l, i, a) => a.indexOf(l) === i);
	const summary =
		problems.length > 0 ? `${errors} errors, ${warnings} warnings` : `clean (${lines.length} lines)`;
	return { oneLiner: `◆ ${shortCmd} — ${summary}`, details: details.join("\n") };
}

function compactGitOutput(text: string, cmd: string, shortCmd: string): { oneLiner: string; details: string } {
	const lines = text.split("\n");
	const kept = lines.filter((l) => !/^(@@|[+-][^+-])/.test(l));
	const stat = lines.find((l) => /files? changed/i.test(l))?.trim() ?? `${kept.length} lines`;
	const sub = (cmd.trim().split(/\s+/)[1] ?? "").replace(/[^a-z-]/gi, "") || "output";
	return { oneLiner: `◆ git ${sub} — ${stat}`, details: kept.join("\n") };
}

function aggregateLinterOutput(text: string, shortCmd: string): { oneLiner: string; details: string } {
	const problems = text.split("\n").filter((l) => ERROR_RE.test(l));
	return {
		oneLiner: `◆ ${shortCmd} — ${problems.length} problems`,
		details: problems.join("\n"),
	};
}

function groupSearchResults(
	text: string,
	pattern: string,
): { oneLiner: string; details: string } | null {
	const lines = text.split("\n").filter((l) => l.trim());
	const groups = new Map<string, string[]>();
	let hits = 0;
	for (const line of lines) {
		const m = line.match(/^([^:]+):(\d+)(?::(\d+))?:(.*)$/);
		if (!m) return null;
		hits++;
		const file = m[1];
		if (!groups.has(file)) groups.set(file, []);
		const list = groups.get(file);
		if (list && list.length < 3) list.push(line);
	}
	if (groups.size === 0) return null;
	const label = pattern ? `\`${pattern}\`` : "search";
	const details: string[] = [];
	for (const [file, first] of groups) {
		const total = lines.filter((l) => l === file || l.startsWith(`${file}:`)).length;
		details.push(`${file}: ${total} hits (first ${first.length} shown)`);
		details.push(...first);
	}
	return {
		oneLiner: `◆ Search ${label} — ${groups.size} files, ${hits} hits`,
		details: details.join("\n"),
	};
}

function truncateDetails(details: string): { details: string; truncated: boolean } {
	const lines = details.split("\n");
	let out = details;
	let truncated = false;
	if (lines.length > MAX_LINES) {
		const omitted = lines.length - MAX_LINES;
		out = [...lines.slice(0, 120), `… [${omitted} lines omitted] …`, ...lines.slice(-79)].join("\n");
		truncated = true;
	}
	if (out.length > MAX_CHARS) {
		const cut = out.length - MAX_CHARS;
		out = `${out.slice(0, 9000)}\n… [truncated ${cut} chars] …\n${out.slice(-2900)}`;
		truncated = true;
	}
	return { details: out, truncated };
}

export function collapseToolText(
	toolName: string,
	input: unknown,
	text: string,
): CollapseResult {
	if (!text) return { text, changed: false, rule: "", fullText: text };
	const fields = (input ?? {}) as Record<string, unknown>;
	const stripped = text.replace(ANSI_RE, "");
	const rules: string[] = [];
	if (stripped !== text) rules.push("ansi");

	let oneLiner = "";
	let details = stripped;

	if (toolName === "bash") {
		const cmd = typeof fields["command"] === "string" ? (fields["command"] as string) : "";
		const short = shortCommandText(cmd);
		if (isTestCommand(cmd)) {
			const r = aggregateTestOutput(stripped, `bash \`${short}\``);
			oneLiner = r.oneLiner;
			details = r.details;
			rules.push("test");
		} else if (isBuildCommand(cmd)) {
			const r = filterBuildOutput(stripped, `bash \`${short}\``);
			oneLiner = r.oneLiner;
			details = r.details;
			rules.push("build");
		} else if (isGitCommand(cmd)) {
			const r = compactGitOutput(stripped, cmd, short);
			oneLiner = r.oneLiner;
			details = r.details;
			rules.push("git");
		} else if (isLinterCommand(cmd)) {
			const r = aggregateLinterOutput(stripped, `bash \`${short}\``);
			oneLiner = r.oneLiner;
			details = r.details;
			rules.push("linter");
		} else {
			oneLiner = `◆ ${short}`;
		}
	} else if (toolName === "read") {
		const p = typeof fields["path"] === "string" ? (fields["path"] as string) : "file";
		const one = p.replace(/\s+/g, " ").trim();
		const short = one.length > 80 ? `${one.slice(0, 80)}…` : one || "file";
		oneLiner = `◆ Read ${short}`;
		rules.push("read");
	} else if (toolName === "grep") {
		const raw = fields["pattern"] ?? fields["query"] ?? "";
		const pattern = typeof raw === "string" ? raw : "";
		const grouped = groupSearchResults(stripped, pattern);
		if (grouped) {
			oneLiner = grouped.oneLiner;
			details = grouped.details;
			rules.push("grep");
		} else {
			oneLiner = `◆ Search${pattern ? ` \`${pattern}\`` : ""}`;
		rules.push("grep");
		}
	} else if (toolName === "glob") {
		// Native glob emits a plain path list (input key is `path`, live-probed
		// 2026-09-11); groupSearchResults only parses file:line:col hits, so a
		// dedicated branch owns file lists. Non-list output falls back to the
		// generic collapse below — never raw output.
		const raw = fields["pattern"] ?? fields["query"] ?? fields["path"] ?? "";
		const pattern = typeof raw === "string" ? raw : "";
		const files = stripped.split("\n").filter((l) => l.trim());
		oneLiner = pattern
			? `◆ Glob \`${pattern}\` — ${files.length} files`
			: `◆ Glob — ${files.length} files`;
		rules.push("glob");
	} else {
		if (rules.length === 0) return { text, changed: false, rule: "", fullText: text };
		oneLiner = `◆ ${toolName}`;
	}

	const capped = truncateDetails(details);
	if (capped.truncated) rules.push("truncate");
	const finalText = capped.details ? `${oneLiner}\n${capped.details}` : oneLiner;
	if (finalText === text) return { text, changed: false, rule: "", fullText: text };
	return { text: finalText, changed: true, rule: rules.join(",") || "collapse", fullText: stripped };
}
