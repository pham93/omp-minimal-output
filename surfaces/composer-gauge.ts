/**
 * Context-usage gauge: renders the `[███░░] 12%/200K` replacement for the
 * host's context segment and keeps the gauge visible when a row is truncated.
 * Pure — the caller passes the live usage reading.
 */
import type { ContextUsage } from "@oh-my-pi/pi-coding-agent";
import { sliceByColumn, visibleWidth, type ComposerChromeContext } from "@oh-my-pi/pi-tui";
import {
  CONTEXT_GAUGE_CAPS,
  CONTEXT_GAUGE_MAX_WIDTH,
  PROJECT_ICON_VARIANTS,
  fitStatusContent,
} from "./composer-primitives.ts";

function formatContextPercent(percent: number): string {
  return `${percent > 0 && percent < 1 ? percent.toFixed(1) : Math.round(percent)}%`;
}

function formatContextWindow(contextWindow: number): string {
  if (contextWindow >= 1_000_000) {
    const millions = Math.round((contextWindow / 1_000_000) * 10) / 10;
    return `${millions}M`;
  }
  if (contextWindow >= 1_000) return `${Math.round(contextWindow / 1_000)}K`;
  return `${Math.max(0, Math.round(contextWindow))}`;
}

function explicitContextGauge(ctx: ComposerChromeContext, width: number, usage: ContextUsage): string | undefined {
  const percent = Number.isFinite(usage.percent) ? usage.percent : 0;
  const label = `${formatContextPercent(percent)}/${formatContextWindow(usage.contextWindow)}`;
  const labelWidth = visibleWidth(label);
  const trackWidth = width - labelWidth - 3;
  if (trackWidth < 4) return labelWidth <= width ? ctx.accentColor(label) : undefined;

  const clamped = Math.min(100, Math.max(0, percent));
  const used = Math.min(trackWidth, Math.max(0, Math.round((clamped / 100) * trackWidth)));
  const remaining = trackWidth - used;
  return `${ctx.borderColor("[")}${ctx.accentColor("█".repeat(used))}${ctx.borderColor("░".repeat(remaining))}${ctx.borderColor("]")} ${label}`;
}
function embeddedGaugeColumns(content: string): { start: number; end: number } | undefined {
  try {
    const plain = Bun.stripANSI(content);
    let best: { start: number; end: number; width: number } | undefined;

    for (const match of plain.matchAll(/\S*%\S*/gu)) {
      const text = match[0];
      const index = match.index;
      if (index === undefined || !/[\u2500-\u259f]/u.test(text)) continue;

      const start = visibleWidth(plain.slice(0, index));
      const width = visibleWidth(text);
      if (width < 8 || (best && best.width >= width)) continue;
      best = { start, end: start + width, width };
    }

    if (best) return { start: best.start, end: best.end };

    for (const match of plain.matchAll(/[\u2500-\u259f]{3,}/gu)) {
      const text = match[0];
      const index = match.index;
      if (index === undefined) continue;

      const start = visibleWidth(plain.slice(0, index));
      const width = visibleWidth(text);
      if (width < 3 || (best && best.width >= width)) continue;
      best = { start, end: start + width, width };
    }

    return best ? { start: best.start, end: best.end } : undefined;
  } catch {
    return undefined;
  }
}
function containsProjectIcon(plain: string): boolean {
  return PROJECT_ICON_VARIANTS.some(
    (variant) => plain.includes(`${variant.host} `) || plain.includes(`${variant.replacement} `),
  );
}

function isContextGaugeInterior(content: string): boolean {
  const plain = Bun.stripANSI(content);
  if (!plain.trim() || containsProjectIcon(plain)) return false;
  if (/\d+\s*%\s*\/\s*\d+[KMG]?\b/u.test(plain)) return true;
  if (/\[[█░]+\]/u.test(plain)) return true;
  return /[\u2500-\u259f]{3,}/u.test(plain);
}
export function replaceContextGauge(
  content: string,
  ctx: ComposerChromeContext,
  usage: ContextUsage | undefined,
  widthReduction = 0,
): string {
  try {
    if (!usage || usage.contextWindow <= 0) return content;

    const reduction = Math.max(0, Math.floor(widthReduction));
    for (const caps of CONTEXT_GAUGE_CAPS) {
      const right = content.lastIndexOf(caps.right);
      if (right < 0) continue;
      const left = content.lastIndexOf(caps.left, right - 1);
      if (left < 0) continue;
      const end = right + caps.right.length;
      const interior = content.slice(left + caps.left.length, right);
      if (!isContextGaugeInterior(interior)) continue;
      const gaugeWidth = Math.min(
        CONTEXT_GAUGE_MAX_WIDTH,
        Math.max(0, visibleWidth(content.slice(left, end)) - reduction),
      );
      const gauge = explicitContextGauge(ctx, gaugeWidth, usage);
      return gauge ? `${content.slice(0, left)}${gauge}${content.slice(end)}` : content;
    }

    const columns = embeddedGaugeColumns(content);
    if (!columns) return content;

    const gaugeWidth = Math.min(CONTEXT_GAUGE_MAX_WIDTH, Math.max(0, columns.end - columns.start - reduction));
    const gauge = explicitContextGauge(ctx, gaugeWidth, usage);
    if (!gauge) return content;

    const totalWidth = visibleWidth(content);
    const left = sliceByColumn(content, 0, columns.start, true);
    const right = sliceByColumn(content, columns.end, totalWidth - columns.end, true);
    return `${left}${gauge}${right}`;
  } catch {
    return content;
  }
}

function contextGaugeLabel(usage: ContextUsage): string {
  return `${formatContextPercent(usage.percent)}/${formatContextWindow(usage.contextWindow)}`;
}
export function ensureGaugeVisible(
  text: string,
  body: string,
  bodyWidth: number,
  ctx: ComposerChromeContext,
  usage: ContextUsage | undefined,
): string {
  try {
    if (!usage || usage.contextWindow <= 0 || bodyWidth <= 0) return body;
    const plain = Bun.stripANSI(body);
    if (plain.includes(contextGaugeLabel(usage)) || /\b\d+%\s*\/\s*\d+[KMG]?\b/u.test(plain)) return body;
    const gauge = explicitContextGauge(ctx, Math.min(CONTEXT_GAUGE_MAX_WIDTH, bodyWidth), usage);
    if (!gauge) return body;
    const need = visibleWidth(gauge) + 1;
    if (need >= bodyWidth) return fitStatusContent(gauge, bodyWidth, false);
    const inner = fitStatusContent(text, bodyWidth - need, false);
    return inner ? `${inner} ${gauge}` : gauge;
  } catch {
    return body;
  }
}
