// Ohmypi plugin settings store reader. Single source of truth is the
// Ohmypi lockfile (~/.omp/plugins/omp-plugins.lock.json
// settings["@local/omp-minimal-output"]); project overrides are Ohmypi's
// own .omp/.pi plugin-overrides.json files. No plugin-owned YAML.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export const PLUGIN_NAME = "@local/omp-minimal-output";

export const WRAP_CANDIDATES = ["bash", "read", "grep", "glob", "write", "edit", "eval"] as const;
export type WrapCandidate = (typeof WRAP_CANDIDATES)[number];

export const NATIVE_KEY = {
  bash: "nativeBash",
  read: "nativeRead",
  grep: "nativeGrep",
  glob: "nativeGlob",
  write: "nativeWrite",
  edit: "nativeEdit",
  eval: "nativeEval",
} as const;

export const INDICATOR = {
  diamond: { frames: ["◈", "◉", "◎", "○"], settled: "◆" },
  dot: { frames: ["●", "○", "◉", "○"], settled: "●" },
  none: { frames: [" "], settled: " " },
} as const;
export type IndicatorId = keyof typeof INDICATOR;

export interface PluginConfig {
  opacity: number;
  indicator: IndicatorId;
  indicatorAnimation: boolean;
  nativeBash: boolean;
  nativeRead: boolean;
  nativeGrep: boolean;
  nativeGlob: boolean;
  nativeWrite: boolean;
  nativeEdit: boolean;
  nativeEval: boolean;
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
  nativeGlob: false,
  nativeWrite: false,
  nativeEdit: false,
  nativeEval: false,
  todosHeader: true,
  todoHud: false,
  todoReminderOneLine: true,
  editShowTabs: true,
  editShowSpaces: false,
};

const BOOLEAN_KEYS = [
  "indicatorAnimation",
  "nativeBash",
  "nativeRead",
  "nativeGrep",
  "nativeGlob",
  "nativeWrite",
  "nativeEdit",
  "nativeEval",
  "todosHeader",
  "todoHud",
  "todoReminderOneLine",
  "editShowTabs",
  "editShowSpaces",
] as const;
type BooleanKey = (typeof BOOLEAN_KEYS)[number];

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
      if ((BOOLEAN_KEYS as readonly string[]).includes(key)) {
        const v = src[key];
        if (typeof v === "boolean") {
          (next as unknown as Record<BooleanKey, boolean>)[key as BooleanKey] = v;
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

export function wrapTool(name: string, cfg: PluginConfig = getPluginConfig()): boolean {
  if (!(WRAP_CANDIDATES as readonly string[]).includes(name)) return false;
  const key = NATIVE_KEY[name as WrapCandidate];
  return cfg[key] !== true;
}

export function indicatorFrames(cfg: PluginConfig = getPluginConfig()): readonly string[] {
  return INDICATOR[cfg.indicator].frames;
}

export function indicatorSettled(cfg: PluginConfig = getPluginConfig()): string {
  return INDICATOR[cfg.indicator].settled;
}

// Prime the cache at import so tool_result works before session_start fires.
loadPluginConfig();
