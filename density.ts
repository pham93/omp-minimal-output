import { DETAIL_LEVEL, getPluginConfig, type DetailLevel, type PluginConfig } from "./config.ts";

export interface DetailProfile {
  level: DetailLevel;
  minimal: boolean;
  standard: boolean;
  detailed: boolean;
}

export function optionsExpanded(options: unknown): boolean {
  return typeof options === "object" && options !== null && "expanded" in options && options.expanded === true;
}

export function effectiveDetailLevel(options: unknown, config: PluginConfig = getPluginConfig()): DetailLevel {
  return optionsExpanded(options) ? DETAIL_LEVEL.detailed : config.detailLevel;
}

export function detailProfile(options: unknown, config: PluginConfig = getPluginConfig()): DetailProfile {
  const level = effectiveDetailLevel(options, config);
  return {
    level,
    minimal: level === DETAIL_LEVEL.minimal,
    standard: level === DETAIL_LEVEL.standard,
    detailed: level === DETAIL_LEVEL.detailed,
  };
}

export function standardRowLimit(hasOutput: boolean, config: PluginConfig = getPluginConfig()): number {
  return hasOutput ? config.standardOutputMaxRows : config.standardMaxRows;
}

export function standardEditRowsPerFile(config: PluginConfig = getPluginConfig()): number {
  return config.standardEditRowsPerFile;
}

export function standardWriteMaxRows(config: PluginConfig = getPluginConfig()): number {
  return config.standardWriteMaxRows;
}

export function detailedRowLimit(config: PluginConfig = getPluginConfig()): number {
  return config.detailedMaxRows;
}

export function profileRowLimit(
  profile: DetailProfile,
  standardMaxRows: number,
  config: PluginConfig = getPluginConfig(),
): number {
  return profile.detailed ? config.detailedMaxRows : standardMaxRows;
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
