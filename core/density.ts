import { DETAIL_LEVEL, getPluginConfig, type DetailLevel, type PluginConfig } from "./config.ts";

export interface DetailProfile {
  level: DetailLevel;
  minimal: boolean;
  standard: boolean;
  detailed: boolean;
  detailedMaxRows?: number;
}

export function optionsExpanded(options: unknown): boolean {
  return typeof options === "object" && options !== null && "expanded" in options && options.expanded === true;
}

export function optionsMinimal(options: unknown): boolean {
  return typeof options === "object" && options !== null && "minimal" in options && options.minimal === true;
}

export function effectiveConfig(options: unknown, config: PluginConfig = getPluginConfig()): PluginConfig {
  if (typeof options === "object" && options !== null && "detailedMaxRows" in options) {
    const v = (options as { detailedMaxRows?: unknown }).detailedMaxRows;
    if (typeof v === "number" && Number.isFinite(v)) return { ...config, detailedMaxRows: v };
  }
  return config;
}

export function effectiveDetailLevel(options: unknown, config: PluginConfig = getPluginConfig()): DetailLevel {
  if (optionsExpanded(options)) return DETAIL_LEVEL.detailed;
  if (optionsMinimal(options)) return DETAIL_LEVEL.minimal;
  return config.detailLevel;
}

export function detailProfile(options: unknown, config: PluginConfig = getPluginConfig()): DetailProfile {
  const cfg = effectiveConfig(options, config);
  const level = effectiveDetailLevel(options, cfg);
  return {
    level,
    minimal: level === DETAIL_LEVEL.minimal,
    standard: level === DETAIL_LEVEL.standard,
    detailed: level === DETAIL_LEVEL.detailed,
    detailedMaxRows: cfg.detailedMaxRows,
  };
}

export function inputRowLimit(profile: DetailProfile, config: PluginConfig = getPluginConfig()): number {
  if (profile.minimal) return 1;
  const detailedCap = profile.detailedMaxRows ?? config.detailedMaxRows;
  return profile.detailed ? detailedCap : config.standardMaxRows;
}

export function outputRowLimit(profile: DetailProfile, config: PluginConfig = getPluginConfig()): number {
  if (profile.minimal) return 1;
  const detailedCap = profile.detailedMaxRows ?? config.detailedMaxRows;
  return profile.detailed ? detailedCap : config.standardOutputMaxRows;
}

export function standardEditRowsPerFile(config: PluginConfig = getPluginConfig()): number {
  return config.standardEditRowsPerFile;
}

export function standardWriteMaxRows(config: PluginConfig = getPluginConfig()): number {
  return config.standardWriteMaxRows;
}

export function detailedRowLimit(
  configOrProfile?: DetailProfile | PluginConfig,
  fallbackConfig: PluginConfig = getPluginConfig(),
): number {
  if (configOrProfile && "detailedMaxRows" in configOrProfile && typeof configOrProfile.detailedMaxRows === "number") {
    return configOrProfile.detailedMaxRows;
  }
  return fallbackConfig.detailedMaxRows;
}

export function thoughtRowLimit(profile: DetailProfile, config: PluginConfig = getPluginConfig()): number {
  if (profile.minimal) return 1;
  const detailedCap = profile.detailedMaxRows ?? config.detailedMaxRows;
  return profile.detailed ? detailedCap : config.standardMaxRows;
}

export function minimalToolSummary(status: string, tool: string): string {
  const parent = status.trim();
  const child = tool.trim();
  if (!parent) return child;
  if (!child) return parent;
  return `${parent} — ${child}`;
}

export function boundedPreview<T>(rows: readonly T[], maxRows: number): { visible: readonly T[]; hidden: number } {
  const cap = Math.max(0, Math.floor(maxRows));
  if (rows.length <= cap) return { visible: rows, hidden: 0 };
  return { visible: rows.slice(0, cap), hidden: rows.length - cap };
}

export function capRenderedRows<T>(rows: readonly T[], maxRows: number, overflowRow: T, terminalRow?: T): T[] {
  const cap = Math.max(1, Math.floor(maxRows));
  if (rows.length <= cap) return [...rows];
  const last = terminalRow ?? overflowRow;
  if (cap === 1) return [last];
  return [...rows.slice(0, cap - 1), last];
}
