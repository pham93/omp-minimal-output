// Pure string helpers for labels, wrapping, and truncation. Zero dependencies
// beyond pi-tui width measurement. No module state, no side effects.
import { homedir } from "node:os";
import { visibleWidth } from "@oh-my-pi/pi-tui";

export function tildePath(p: string): string {
  const one = String(p ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!one) return "file";
  try {
    const home = homedir();
    if (home && (one === home || one.startsWith(home + "/"))) return `~${one.slice(home.length)}`;
  } catch {
    // homedir unavailable; fall through to raw path.
  }
  return one;
}
export function shortCommandText(cmd: string): string {
  const oneLine = cmd.replace(/\s+/g, " ").trim();
  return oneLine || "bash";
}

export function wrapToWidth(text: string, width: number): string[] {
  const max = Math.max(8, Math.floor(width));
  const out: string[] = [];
  for (const para of text.split(/\n+/)) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (visibleWidth(next) <= max) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      if (visibleWidth(word) <= max) {
        line = word;
        continue;
      }
      let rest = word;
      while (visibleWidth(rest) > max) {
        let lo = 1;
        let hi = rest.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (visibleWidth(rest.slice(0, mid)) <= max) lo = mid;
          else hi = mid - 1;
        }
        out.push(rest.slice(0, lo));
        rest = rest.slice(lo);
      }
      line = rest;
    }
    if (line) out.push(line);
  }
  return out;
}

export function wrapLatestLines(text: string, width: number, maxLines: number): string[] {
  if (!text.trim() || maxLines <= 0) return [];
  return wrapToWidth(text.trim(), width).slice(-maxLines);
}

export function truncatePlain(text: string, max: number): string {
  if (max <= 0) return "";
  if (visibleWidth(text) <= max) return text;
  const budget = Math.max(1, max - 1);
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (visibleWidth(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  // Never cut inside an escape sequence: back off to before its ESC.
  const head = text.slice(0, lo);
  const esc = head.lastIndexOf("");
  const end = esc !== -1 && !head.slice(esc).includes("m") ? esc : lo;
  return `${text.slice(0, end)}…`;
}

// Visible whitespace rendering for diff rows: tabs show as → and spaces as ·
// only when the corresponding flag is true. Applied after syntax highlighting
// (SGR carries no tabs, so the replacement cannot corrupt escapes); markers
// inherit the row color, keeping contrast with the band.
export function showWhitespace(text: string, opts: { tabs: boolean; spaces: boolean }): string {
  if (!text) return text;
  let out = text;
  if (opts.tabs) out = out.replace(/\t/g, "→");
  if (opts.spaces) out = out.replace(/ /g, "·");
  return out;
}

export function shortPathText(p: string): string {
  const one = String(p ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!one) return "file";
  return one.length > 80 ? `${one.slice(0, 80)}…` : one;
}

export function titleCaseWords(raw: string): string {
  return raw
    .replace(/[/_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export function stripKindSuffix(text: string): string {
  return text.replace(/\s*\((?:Edit|Write|Create|Delete|Read|Search|Glob|Bash)\)\s*$/i, "").trimEnd();
}

export function fileNameFromArgs(args: unknown): string {
  const fields = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const raw =
    (typeof fields["path"] === "string" && fields["path"]) ||
    (typeof fields["file_path"] === "string" && fields["file_path"]) ||
    (typeof fields["file"] === "string" && fields["file"]) ||
    "";
  if (raw.trim()) {
    const one = raw.replace(/\s+/g, " ").trim();
    return one.split("/").pop() || one;
  }
  const blob =
    (typeof fields["input"] === "string" && fields["input"]) ||
    (typeof fields["patch"] === "string" && fields["patch"]) ||
    "";
  const marked = /(?:Update File|Add File|Delete File):\s*(\S+)/.exec(blob);
  if (marked?.[1]) {
    const p = marked[1].trim();
    return p.split("/").pop() || p;
  }
  return "file";
}

export function toolActionLabel(toolName: string, args: unknown): string {
  const fields = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const name = toolName.trim();
  if (name === "read") {
    const path = typeof fields["path"] === "string" ? fields["path"] : "file";
    // Bare full path: read groups render one row per file under a
    // `Read N files` dot parent, so the row itself carries no verb.
    // Home-collapsed: skinner and wrap rows share this shape.
    return tildePath(path);
  }
  if (name === "write") {
    return `Write ${fileNameFromArgs(args)}`;
  }
  if (name === "bash" || name === "shell") {
    const cmd = typeof fields["command"] === "string" ? fields["command"] : "";
    return shortCommandText(cmd) || "Bash";
  }
  if (name === "grep") {
    const pattern = searchPatternText(args);
    return pattern.trim() ? `Search \`${shortCommandText(pattern)}\`` : "Search";
  }
  if (name === "eval") {
    return evalLabelText(fields);
  }
  const slash = name.lastIndexOf("/");
  if (slash >= 0) {
    const ns = titleCaseWords(name.slice(0, slash).replace(/^mcp[_-]?/i, ""));
    const action = titleCaseWords(name.slice(slash + 1));
    return `${ns} ${action}`.trim();
  }
  return titleCaseWords(name) || name;
}

export function searchPatternText(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const fields = args as Record<string, unknown>;
  const raw = fields["pattern"] ?? fields["query"] ?? fields["path"] ?? "";
  return typeof raw === "string" ? raw : "";
}

// Language icons for eval headers. Keys are normalized highlighter ids;
// unknown languages get no icon rather than a placeholder.
const EVAL_LANG_ICONS: Record<string, string> = {
  python: "🐍",
  javascript: "🟨",
  jsx: "🟨",
  typescript: "🔷",
  tsx: "🔷",
  shell: "🐚",
  bash: "🐚",
  ruby: "💎",
  go: "🐹",
  rust: "🦀",
};

export interface EvalCell {
  language?: string;
  code?: string;
  title?: string;
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

// Merged eval cell: `cells[0]` wins, top-level args fill the gaps. The tool
// speaks `py`/`js`; normalize to the highlighter ids `python`/`javascript`
// (ground truth: core's own eval renderer maps the same way).
export function evalCell(args: unknown): EvalCell {
  const fields = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const rawCells = fields["cells"];
  const first =
    Array.isArray(rawCells) && typeof rawCells[0] === "object" && rawCells[0] !== null
      ? (rawCells[0] as Record<string, unknown>)
      : undefined;
  const rawLang = (firstString(first?.["language"], fields["language"]) ?? "").trim().toLowerCase();
  const language =
    rawLang === "py" ? "python" : rawLang === "js" ? "javascript" : rawLang === "" ? undefined : rawLang;
  return {
    language,
    code: firstString(first?.["code"], fields["code"], fields["input"], fields["content"], fields["command"]),
    title: firstString(first?.["title"], fields["title"])?.trim(),
  };
}

// Normalized eval language id (`python`, `javascript`, …), if any.
export function evalLanguage(args: unknown): string | undefined {
  return evalCell(args).language;
}

export function evalLangIcon(args: unknown): string {
  return EVAL_LANG_ICONS[evalLanguage(args) ?? ""] ?? "";
}

// Short eval header with the language icon up front: title as-is, else the
// first code line, else the language. No ◆ prefix — formatRowLine paints the
// mark. eval-card.ts renders this; filters.ts mirrors the same order.
export function evalLabelText(args: unknown): string {
  const cell = evalCell(args);
  const icon = evalLangIcon(args);
  const pre = icon ? `${icon} ` : "";
  if (cell.title) return `${pre}${truncatePlain(cell.title, 80)}`;
  const first = cell.code
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line);
  if (first) return icon ? `${pre}${truncatePlain(first, 60)}` : `Eval ${truncatePlain(first, 60)}`;
  if (!cell.language) return "Eval";
  return icon ? `${pre}${truncatePlain(cell.language, 20)}` : `Eval ${truncatePlain(cell.language, 20)}`;
}
