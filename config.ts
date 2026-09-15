// Ohmypi plugin settings store reader. Single source of truth is the
// Ohmypi lockfile (~/.omp/plugins/omp-plugins.lock.json
// settings["@local/omp-minimal-output"]); project overrides are Ohmypi's
// own .omp/.pi plugin-overrides.json files. No plugin-owned YAML.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export const PLUGIN_NAME = "@local/omp-minimal-output";

export const STATIC_TOOL_APPROVAL = {
  read: "read",
  write: "write",
  exec: "exec",
} as const;
export type StaticToolApproval = (typeof STATIC_TOOL_APPROVAL)[keyof typeof STATIC_TOOL_APPROVAL];

export interface WrappedToolDefinition {
  nativeKey: string;
  approval?: StaticToolApproval;
}

export const WRAPPED_TOOL_REGISTRY = {
  bash: { nativeKey: "nativeBash" },
  read: { nativeKey: "nativeRead" },
  grep: { nativeKey: "nativeGrep" },
  glob: { nativeKey: "nativeGlob", approval: STATIC_TOOL_APPROVAL.read },
  write: { nativeKey: "nativeWrite" },
  edit: { nativeKey: "nativeEdit" },
  eval: { nativeKey: "nativeEval", approval: STATIC_TOOL_APPROVAL.exec },
  web_search: { nativeKey: "nativeWebSearch", approval: STATIC_TOOL_APPROVAL.read },
} as const satisfies Record<string, WrappedToolDefinition>;

export type WrappedTool = keyof typeof WRAPPED_TOOL_REGISTRY;
export type WrappedToolConfigKey = (typeof WRAPPED_TOOL_REGISTRY)[WrappedTool]["nativeKey"];
type WrappedToolSettings = Record<WrappedToolConfigKey, boolean>;

export const INDICATOR = {
  diamond: { frames: ["◈", "◉", "◎", "○"], settled: "◆" },
  dot: { frames: ["●", "○", "◉", "○"], settled: "●" },
  none: { frames: [" "], settled: " " },
} as const;
export type IndicatorId = keyof typeof INDICATOR;

export interface PluginConfig extends WrappedToolSettings {
  opacity: number;
  indicator: IndicatorId;
  indicatorAnimation: boolean;
  grepMaxMatches: number;
  nativeAstGrep: boolean;
  astGrepMaxMatches: number;
  nativeLsp: boolean;
  lspMaxItems: number;
  nativeDebug: boolean;
  debugMaxItems: number;
  nativeTask: boolean;
  taskMaxAgents: number;
  nativeHub: boolean;
  hubMaxItems: number;
  webSearchMaxResults: number;
  todosHeader: boolean;
  todoHud: boolean;
  todoReminderOneLine: boolean;
  editShowTabs: boolean;
  editShowSpaces: boolean;
}

export const DEFAULT_CONFIG: PluginConfig = {
  opacity: 0.5,
  indicator: "diamond",
  indicatorAnimation: true,
  nativeBash: false,
  nativeRead: false,
  nativeGrep: false,
  grepMaxMatches: 5,
  nativeAstGrep: false,
  astGrepMaxMatches: 5,
  nativeLsp: false,
  lspMaxItems: 5,
  nativeDebug: false,
  debugMaxItems: 5,
  nativeGlob: false,
  nativeWrite: false,
  nativeEdit: false,
  nativeEval: false,
  nativeWebSearch: false,
  nativeTask: false,
  taskMaxAgents: 4,
  nativeHub: false,
  hubMaxItems: 5,
  webSearchMaxResults: 5,
  todosHeader: true,
  todoHud: false,
  todoReminderOneLine: true,
  editShowTabs: true,
  editShowSpaces: false,
};

const BOOLEAN_KEYS: Record<string, true> = {
  indicatorAnimation: true,
  nativeAstGrep: true,
  nativeLsp: true,
  nativeDebug: true,
  nativeTask: true,
  nativeHub: true,
  todosHeader: true,
  todoHud: true,
  todoReminderOneLine: true,
  editShowTabs: true,
  editShowSpaces: true,
};
for (const definition of Object.values(WRAPPED_TOOL_REGISTRY)) {
  BOOLEAN_KEYS[definition.nativeKey] = true;
}

export function lockfilePath(): string {
  return join(homedir(), ".omp", "plugins", "omp-plugins.lock.json");
}

export function projectOverridePaths(): string[] {
  const cwd = process.cwd();
  return [join(cwd, ".omp", "plugin-overrides.json"), join(cwd, ".pi", "plugin-overrides.json")];
}

function settingsOf(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const settings = (parsed as Record<string, unknown>)["settings"];
  if (typeof settings !== "object" || settings === null) return undefined;
  return (settings as Record<string, unknown>)[PLUGIN_NAME];
}

function readSettingsLayer(path: string): unknown {
  try {
    const raw = readFileSync(path, "utf8");
    return settingsOf(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function applyOverlay(base: PluginConfig, raw: unknown): PluginConfig {
  const next: PluginConfig = { ...base };
  if (typeof raw !== "object" || raw === null) return next;
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    try {
      if (key === "opacity") {
        const v = src[key];
        if (typeof v === "number" && Number.isFinite(v)) {
          next.opacity = Math.min(1, Math.max(0, v));
        }
        continue;
      }
      if (key === "indicator") {
        const v = src[key];
        if (typeof v === "string" && v in INDICATOR) {
          next.indicator = v as IndicatorId;
        }
        continue;
      }
      if (key === "webSearchMaxResults") {
        const v = src[key];
        if (typeof v === "number" && Number.isFinite(v)) {
          next.webSearchMaxResults = Math.min(10, Math.max(1, Math.floor(v)));
        }
        continue;
      }
    if (key === "grepMaxMatches") {
      const v = src[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        next.grepMaxMatches = Math.min(20, Math.max(1, Math.floor(v)));
      }
      continue;
    }
    if (key === "astGrepMaxMatches") {
      const v = src[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        next.astGrepMaxMatches = Math.min(20, Math.max(1, Math.floor(v)));
      }
      continue;
    }
    if (key === "lspMaxItems") {
      const v = src[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        next.lspMaxItems = Math.min(10, Math.max(1, Math.floor(v)));
      }
      continue;
    }
    if (key === "debugMaxItems") {
      const v = src[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        next.debugMaxItems = Math.min(10, Math.max(1, Math.floor(v)));
      }
      continue;
    }
      if (key === "taskMaxAgents") {
        const v = src[key];
        if (typeof v === "number" && Number.isFinite(v)) {
          next.taskMaxAgents = Math.min(8, Math.max(1, Math.floor(v)));
        }
        continue;
      }
      if (key === "hubMaxItems") {
        const v = src[key];
        if (typeof v === "number" && Number.isFinite(v)) {
          next.hubMaxItems = Math.min(10, Math.max(1, Math.floor(v)));
        }
        continue;
      }
      if (BOOLEAN_KEYS[key] === true) {
        const v = src[key];
        if (typeof v === "boolean") {
          (next as unknown as Record<string, unknown>)[key] = v;
        }
        continue;
      }
      // Unknown extra keys ignored.
    } catch {
      // Never throw out of load; bad key is skipped.
    }
  }
  return next;
}

let cache: PluginConfig | null = null;

export function loadPluginConfig(): PluginConfig {
  try {
    let cfg: PluginConfig = { ...DEFAULT_CONFIG };
    const lockRaw = readSettingsLayer(lockfilePath());
    if (lockRaw !== undefined) cfg = applyOverlay(cfg, lockRaw);
    for (const p of projectOverridePaths()) {
      const raw = readSettingsLayer(p);
      if (raw !== undefined) cfg = applyOverlay(cfg, raw);
    }
    cache = cfg;
    return cfg;
  } catch {
    const fallback: PluginConfig = { ...DEFAULT_CONFIG };
    cache = fallback;
    return fallback;
  }
}

export function getPluginConfig(): PluginConfig {
  if (cache) return cache;
  return loadPluginConfig();
}

export function reloadPluginConfig(): PluginConfig {
  return loadPluginConfig();
}

export function isWrappedTool(name: string): name is WrappedTool {
  return Object.prototype.hasOwnProperty.call(WRAPPED_TOOL_REGISTRY, name);
}

export function wrapTool(name: string, cfg: PluginConfig = getPluginConfig()): boolean {
  if (!isWrappedTool(name)) return false;
  return cfg[WRAPPED_TOOL_REGISTRY[name].nativeKey] !== true;
}

export function indicatorFrames(cfg: PluginConfig = getPluginConfig()): readonly string[] {
  return INDICATOR[cfg.indicator].frames;
}

export function indicatorSettled(cfg: PluginConfig = getPluginConfig()): string {
  return INDICATOR[cfg.indicator].settled;
}

// Prime the cache at import so tool_result works before session_start fires.
loadPluginConfig();
