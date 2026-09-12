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

function strField(fields: Record<string, unknown>, ...keys: string[]): string {
	const out = fields as Record<string, unknown>;
	for (const k of keys) {
		const v: unknown = out[k];
		if (typeof v === "string" && v.trim()) return v;
	}
	return "";
}

function singleLine(s: string, max = 80): string {
	const one = s.replace(/\s+/g, " ").trim();
	if (!one) return "";
	return one.length > max ? `${one.slice(0, max)}…` : one;
}

function toolTitleCase(raw: string): string {
	const parts = raw.split(/[/_\-.:\s]+/).filter(Boolean);
	if (parts.length === 0) return "Tool";
	return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

function baseName(p: string): string {
	const t = p.replace(/\\/g, "/");
	const i = t.lastIndexOf("/");
	return i === -1 ? t : t.slice(i + 1);
}

function tailField(fields: Record<string, unknown>, ...keys: string[]): string {
	for (const k of keys) {
		const v: unknown = fields[k];
		if (typeof v === "string" && v.trim()) {
			const bits = v.split(/[/:\s]+/).filter(Boolean);
			return bits.length > 0 ? bits[bits.length - 1] : v.trim();
		}
		if (Array.isArray(v) && v.length > 0) return singleLine(v.map(String).join(","), 60);
		if (typeof v === "number") return String(v);
	}
	return "";
}

function collapseMcpText(toolName: string, stripped: string): { oneLiner: string; details: string } {
	const title = toolTitleCase(toolName.replace(/^mcp__/, ""));
	let body = stripped.trim();
	const fence = body.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
	if (fence) body = fence[1].trim();
	try {
		const parsed: unknown = JSON.parse(body);
		if (Array.isArray(parsed)) {
			const parts = parsed.map((item) => {
				if (typeof item === "string") return item.replace(/\s+/g, " ").trim();
				if (item !== null && typeof item === "object") {
					const entries = Object.entries(item as Record<string, unknown>).map(([k, v]) => {
						const sv = typeof v === "string" ? v : (JSON.stringify(v) ?? "");
						const flat = sv.replace(/\s+/g, " ").trim();
						return `${k}: ${flat.length > 160 ? `${flat.slice(0, 160)}…` : flat}`;
					});
					return entries.join(", ");
				}
				return String(item).replace(/\s+/g, " ").trim();
			});
			return { oneLiner: parts.length > 0 ? `◇ ${title} — ${parsed.length} items: ${parts.join("; ")}` : `◇ ${title} — 0 items`, details: "" };
		}
		if (parsed !== null && typeof parsed === "object") {
			const entries = Object.entries(parsed as Record<string, unknown>);
			const lines = entries.map(([k, v]) => {
				const sv = typeof v === "string" ? v : (JSON.stringify(v) ?? "");
				const flat = sv.replace(/\s+/g, " ").trim();
				return `${k}: ${flat.length > 160 ? `${flat.slice(0, 160)}…` : flat}`;
			});
			return { oneLiner: lines.length > 0 ? `◇ ${title} — ${lines.join("; ")}` : `◇ ${title}`, details: "" };
		}
	} catch {
		// fall through to plain text below
	}
	return { oneLiner: `◇ ${title}`, details: stripped };
}

export function collapseToolText(
	toolName: string,
	input: unknown,
	text: string,
): CollapseResult {
	if (!text) return { text, changed: false, rule: "", fullText: text };
	if (toolName === "edit" || toolName === "ast_edit") return { text, changed: false, rule: "", fullText: text };
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
		if (p.startsWith("skill://")) {
			const rest = p.slice("skill://".length);
			const slash = rest.indexOf("/");
			const name = slash === -1 ? rest : rest.slice(0, slash);
			const tail = slash === -1 ? "SKILL.md" : rest.slice(slash + 1) || "SKILL.md";
			oneLiner = `◆ Skill ${name} — ${tail}`;
		} else {
			const one = p.replace(/\s+/g, " ").trim();
			const short = one.length > 80 ? `${one.slice(0, 80)}…` : one || "file";
			oneLiner = `◆ Read ${short}`;
		}
		rules.push("read");
	} else if (toolName === "write") {
		const p = typeof fields["path"] === "string" ? (fields["path"] as string) : (typeof fields["file"] === "string" ? (fields["file"] as string) : "file");
		const one = p.replace(/\s+/g, " ").trim();
		const short = one.length > 80 ? `${one.slice(0, 80)}…` : one || "file";
		oneLiner = `◆ Write ${short}`;
		rules.push("write");
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
	} else if (toolName === "ast_grep") {
		const raw = fields["pattern"] ?? fields["query"] ?? fields["path"] ?? "";
		const pattern = typeof raw === "string" ? raw : "";
		const grouped = groupSearchResults(stripped, pattern);
		if (grouped) {
			oneLiner = grouped.oneLiner;
			details = grouped.details;
		} else {
			oneLiner = `◆ Search${pattern ? ` \`${pattern}\`` : ""}`;
		}
		rules.push("ast_grep");
	} else if (toolName === "lsp") {
		const action = strField(fields, "action", "op");
		const pat = strField(fields, "pattern", "query", "path", "file");
		const grouped = groupSearchResults(stripped, pat || action);
		if (grouped) {
			oneLiner = grouped.oneLiner.replace(/^◆ Search/, action ? `◆ Lsp ${action}` : "◆ Lsp");
		} else {
			const base = baseName(strField(fields, "file", "path"));
			const label = `${action ? ` ${action}` : ""}${base ? ` ${base}` : ""}`.trim();
			oneLiner = label ? `◆ Lsp ${label}` : "◆ Lsp";
		}
		rules.push("lsp");
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
	} else if (toolName === "eval") {
		const label = strField(fields, "title", "language");
		oneLiner = label ? `◆ Eval ${singleLine(label, 60)}` : "◆ Eval";
		rules.push("eval");
	} else if (toolName === "task") {
		const who = strField(fields, "agent", "name");
		const what = singleLine(strField(fields, "task", "prompt", "description"), 80);
		oneLiner = `◆ Task${who ? ` ${who}` : ""}${what ? ` — ${what}` : ""}`.trim() || "◆ Task";
		rules.push("task");
	} else if (toolName === "hub") {
		const op = strField(fields, "op", "action");
		const tail = tailField(fields, "to", "name", "ids");
		oneLiner = `◆ Hub${op ? ` ${op}` : ""}${tail ? ` ${tail}` : ""}`.trim() || "◆ Hub";
		rules.push("hub");
	} else if (toolName === "todo") {
		const op = strField(fields, "op", "action");
		const tail = singleLine(strField(fields, "task", "phase", "text"), 60);
		let counts = "";
		const open = (stripped.match(/\[ \]/g) || []).length;
		const done = (stripped.match(/\[x\]/gi) || []).length;
		if (open + done > 0) counts = ` — ${open} open, ${done} done`;
		oneLiner = `◆ Todo${op ? ` ${op}` : ""}${tail ? ` ${tail}` : ""}${counts}`.trim() || "◆ Todo";
		rules.push("todo");
	} else if (toolName === "debug") {
		const action = strField(fields, "action", "op");
		const target = singleLine(strField(fields, "target", "file", "path", "command", "program", "expression"), 60);
		oneLiner = `◆ Debug${action ? ` ${action}` : ""}${target ? ` ${target}` : ""}`.trim() || "◆ Debug";
		rules.push("debug");
	} else if (toolName === "github") {
		const op = strField(fields, "op", "action");
		const tail = singleLine(strField(fields, "repo", "query", "path", "url"), 60);
		oneLiner = `◆ Github${op ? ` ${op}` : ""}${tail ? ` ${tail}` : ""}`.trim() || "◆ Github";
		rules.push("github");
	} else if (toolName === "web_search") {
		const q = singleLine(strField(fields, "query", "pattern", "q"), 80);
		let counts = "";
		const lines = stripped.split("\n").filter((l) => l.trim());
		const sources = lines.filter((l) => /^[-*] /.test(l.trim()) || /^https?:\/\//.test(l.trim())).length;
		if (sources > 0) counts = ` — ${sources} sources`;
		oneLiner = `◆ Search${q ? ` \`${q}\`` : ""}${counts}`;
		rules.push("web_search");
	} else if (toolName === "checkpoint") {
		const instr = strField(fields, "message", "summary", "label", "text", "checkpoint", "id");
		const first = singleLine((instr || String(input ?? "")).split("\n")[0] ?? "", 60);
		oneLiner = first ? `◆ Checkpoint ${first}` : "◆ Checkpoint";
		rules.push("checkpoint");
	} else if (toolName === "rewind") {
		const tail = tailField(fields, "anchor", "target", "checkpoint", "id", "path");
		oneLiner = tail ? `◆ Rewind ${singleLine(tail, 60)}` : "◆ Rewind";
		rules.push("rewind");
	} else if (toolName === "context_notes") {
		const c = singleLine(strField(fields, "path", "file", "bytes", "note", "notes", "content"), 60);
		oneLiner = c ? `◆ Context Notes ${c}` : "◆ Context Notes";
		rules.push("context_notes");
	} else if (toolName === "new_context") {
		return { text, changed: false, rule: "", fullText: text };
	} else if (toolName === "security_scan") {
		const a = strField(fields, "action", "op");
		const p = singleLine(strField(fields, "path", "file", "target"), 60);
		oneLiner = `◆ Security Scan${a ? ` ${a}` : ""}${p ? ` ${p}` : ""}`.trim() || "◆ Security Scan";
		rules.push("security_scan");
	} else if (toolName === "memory_edit") {
		const m = singleLine(strField(fields, "status", "op", "action", "memory", "name", "result"), 60);
		oneLiner = m ? `◆ Memory Edit ${m}` : "◆ Memory Edit";
		rules.push("memory_edit");
	} else if (toolName === "retain") {
		oneLiner = "◆ Retain";
		rules.push("retain");
	} else if (toolName === "recall") {
		const q = singleLine(strField(fields, "query", "q", "pattern", "text"), 80);
		oneLiner = q ? `◆ Recall ${q}` : "◆ Recall";
		rules.push("recall");
	} else if (toolName === "reflect") {
		const q = singleLine(strField(fields, "query", "q", "pattern", "text"), 80);
		oneLiner = q ? `◆ Reflect ${q}` : "◆ Reflect";
		rules.push("reflect");
	} else if (toolName === "learn") {
		const n = singleLine(strField(fields, "name", "skill", "topic", "title"), 60);
		oneLiner = n ? `◆ Learn ${n}` : "◆ Learn";
		rules.push("learn");
	} else if (toolName === "manage_skill") {
		const op = strField(fields, "op", "action");
		const n = singleLine(strField(fields, "name", "skill"), 60);
		oneLiner = `◆ Manage Skill${op ? ` ${op}` : ""}${n ? ` ${n}` : ""}`.trim() || "◆ Manage Skill";
		rules.push("manage_skill");
	} else if (toolName.startsWith("mcp__") || toolName.includes("/")) {
		const r = collapseMcpText(toolName, stripped);
		oneLiner = r.oneLiner;
		details = r.details;
		rules.push("mcp");
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