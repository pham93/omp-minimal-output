import { Container } from "@oh-my-pi/pi-tui";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { resultDetails } from "./results.ts";
import { formatRowLine } from "./theme.ts";
import { markFlush } from "./loaders.ts";

export const ACTIVITY_LABEL_SOURCE = {
  generated: "generated",
  tool: "tool",
  commentary: "commentary",
} as const;

export type ActivityLabelSource = (typeof ACTIVITY_LABEL_SOURCE)[keyof typeof ACTIVITY_LABEL_SOURCE];

export const ACTIVITY_LABEL_RANK = {
  [ACTIVITY_LABEL_SOURCE.generated]: 0,
  [ACTIVITY_LABEL_SOURCE.tool]: 1,
  [ACTIVITY_LABEL_SOURCE.commentary]: 2,
} as const satisfies Record<ActivityLabelSource, number>;

export const ACTIVITY_RECORD_KIND = {
  live: "live",
  settled: "settled",
} as const;

export type ActivityRecordKind = (typeof ACTIVITY_RECORD_KIND)[keyof typeof ACTIVITY_RECORD_KIND];

export interface ActivityDetails {
  kind?: unknown;
  label?: unknown;
  context?: unknown;
  outcome?: unknown;
  error?: unknown;
  startedAt?: unknown;
  total?: unknown;
  runId?: unknown;
}

export interface ParsedActivityDetails {
  kind: ActivityRecordKind;
  label: string;
  context: string;
  outcome: string;
  error: boolean;
  startedAt: number;
  total: number;
  runId: string;
}

export interface ActivityStatusPaint {
  label: () => string;
  context: () => string;
  outcome: () => string;
  live: () => boolean;
  error: () => boolean;
  visible?: () => boolean;
  fadeKey: string;
}

export function activityDetailsOf(message: unknown): ParsedActivityDetails | undefined {
  try {
    const details = ((message as { details?: unknown })?.details ?? {}) as ActivityDetails;
    if (typeof details.label !== "string" || !details.label) return undefined;
    return {
      kind: details.kind === ACTIVITY_RECORD_KIND.settled ? ACTIVITY_RECORD_KIND.settled : ACTIVITY_RECORD_KIND.live,
      label: details.label,
      context: typeof details.context === "string" ? details.context : "",
      outcome: typeof details.outcome === "string" ? details.outcome : "",
      error: details.error === true,
      startedAt: typeof details.startedAt === "number" && Number.isFinite(details.startedAt) ? details.startedAt : 0,
      total:
        typeof details.total === "number" && Number.isFinite(details.total) && details.total >= 0
          ? Math.floor(details.total)
          : 0,
      runId: typeof details.runId === "string" ? details.runId : "",
    };
  } catch {
    return undefined;
  }
}

export function paintActivityStatus(theme: unknown, status: ActivityStatusPaint): Container {
  const c = new Container();
  c.addChild({
    render: (width: number): readonly string[] => {
      const live = status.live();
      const error = status.error();
      const outcome = status.outcome();
      if (status.visible?.() === false) return [];
      const label = status.label();
      const context = status.context();
      const body = !live && outcome ? `${label} — ${outcome}` : label;
      const lines = [
        formatRowLine(theme, width, {
          body,
          live,
          error,
          fadeKey: status.fadeKey,
        }),
      ];
      if (context) {
        lines.push(
          formatRowLine(theme, width, {
            body: context,
            indent: true,
            tree: "last",
            error,
          }),
        );
      }
      return lines;
    },
  });
  markFlush?.(c);
  return c;
}

export interface ActivityTrackerDeps {
  pi?: ExtensionAPI;
  owns: () => boolean;
  enabled: () => boolean;
}

export class ActivityTracker {
  #activityStartedAt = 0;
  #activityLabel = "";
  #activityLive = false;
  #activityLabelSource: ActivityLabelSource = ACTIVITY_LABEL_SOURCE.generated;
  #activityRunId: string | null = null;
  #activityLiveSent = false;
  #activityContext = "";
  #activitySettledSent = false;
  #activityApiDead = false;
  readonly #activityProcessTag = Math.floor(Math.random() * 36 ** 6).toString(36);
  #activityRunSeq = 0;
  readonly #liveRuns = new Map<string, { label: string; startedAt: number; fp: string }>();
  #activityLeadFp = "";
  readonly #deps: ActivityTrackerDeps;

  constructor(deps: ActivityTrackerDeps) {
    this.#deps = deps;
  }

  get activityLive(): boolean {
    return this.#activityLive;
  }

  get activityLabel(): string {
    return this.#activityLabel;
  }

  get activityLabelSource(): ActivityLabelSource {
    return this.#activityLabelSource;
  }

  get activityRunId(): string | null {
    return this.#activityRunId;
  }

  get liveRunsCount(): number {
    return this.#liveRuns.size;
  }

  get liveRuns(): ReadonlyMap<string, { label: string; startedAt: number; fp: string }> {
    return this.#liveRuns;
  }

  getEarliestStartedAt(): number {
    let earliest = Number.POSITIVE_INFINITY;
    for (const value of this.#liveRuns.values()) earliest = Math.min(earliest, value.startedAt);
    return earliest;
  }

  startTurn(runId?: string): void {
    this.#activityRunSeq += 1;
    this.#activityRunId = runId ?? `${this.#activityProcessTag}-${this.#activityRunSeq}`;
    this.resetPresentation();
  }

  resetPresentation(): void {
    this.#activityLiveSent = false;
    this.#activityContext = "";
    this.#activitySettledSent = false;
  }

  clearRun(): void {
    this.#activityStartedAt = 0;
    this.#activityLabel = "";
    this.#activityLive = false;
    this.#activityLeadFp = "";
    this.#activityLabelSource = ACTIVITY_LABEL_SOURCE.generated;
    this.#activityRunId = null;
    this.resetPresentation();
  }

  sendActivityRecord(details: Record<string, unknown>): void {
    if (!this.#deps.owns() || !this.#deps.enabled() || this.#activityApiDead || !this.#deps.pi) return;
    try {
      this.#deps.pi.sendMessage(
        {
          customType: "minimal-activity",
          content: "",
          display: false,
          details,
        },
        { deliverAs: "aside" },
      );
    } catch {
      this.#activityApiDead = true;
    }
  }

  sendLiveActivity(): void {
    if (!this.#activityRunId || this.#activityLiveSent) return;
    this.#activityLiveSent = true;
    this.sendActivityRecord({
      kind: ACTIVITY_RECORD_KIND.live,
      label: this.#activityLabel,
      context: this.#activityContext,
      startedAt: this.#activityStartedAt,
      runId: this.#activityRunId,
    });
  }

  maybeSendSettledActivity(force = false): void {
    if (!this.#activityLiveSent || this.#activitySettledSent || !this.#activityRunId) return;
    if (!force && this.#liveRuns.size > 0) return;
    this.#activitySettledSent = true;
    const total = this.#activityStartedAt > 0 ? Math.max(0, Math.floor((Date.now() - this.#activityStartedAt) / 1000)) : 0;
    this.sendActivityRecord({
      kind: ACTIVITY_RECORD_KIND.settled,
      label: this.#activityLabel,
      context: this.#activityContext,
      startedAt: this.#activityStartedAt,
      total,
      runId: this.#activityRunId,
    });
  }

  applyIntent(text: string, startedAt: number, source: ActivityLabelSource): void {
    if (!text) return;
    const sourceRank = ACTIVITY_LABEL_RANK[source];
    const currentRank = ACTIVITY_LABEL_RANK[this.#activityLabelSource];
    if (this.#activitySettledSent) {
      this.#activityRunId = null;
      this.#activityLabel = "";
      this.#activityLabelSource = ACTIVITY_LABEL_SOURCE.generated;
      this.resetPresentation();
    }
    if (this.#activityRunId !== null && this.#activityLive) {
      if (sourceRank < currentRank) return;
      this.#activityLabel = text;
      this.#activityLabelSource = source;
      return;
    }
    if (this.#activityRunId !== null && (this.#activityLive || this.#liveRuns.size > 0) && text === this.#activityLabel) {
      this.#activityLive = true;
      if (sourceRank > currentRank) this.#activityLabelSource = source;
      return;
    }
    // Several grouped tools share one status parent. While any child is
    // live, refresh the parent only from an equal or stronger source.
    if (this.#activityRunId !== null && this.#liveRuns.size > 0) {
      if (sourceRank < currentRank) return;
      this.#activityLabel = text;
      this.#activityLabelSource = source;
      this.#activityLive = true;
      return;
    }
    if (this.#activityRunId !== null && this.#activityLabel) {
      this.maybeSendSettledActivity(true);
      this.#activityRunId = null;
      this.resetPresentation();
    }
    this.#activityLabel = text;
    this.#activityLabelSource = source;
    this.#activityRunId = `${this.#activityProcessTag}-${this.#activityRunSeq++}`;
    this.#activityStartedAt = startedAt;
    this.#activityLive = true;
    this.sendLiveActivity();
  }

  recordToolStart(toolCallId: string, fp: string, label: string, startedAt: number, isLead: boolean): void {
    this.#liveRuns.set(toolCallId, { label, startedAt, fp });
    if (isLead || !this.#activityLeadFp) {
      this.#activityLeadFp = fp;
    }
  }

  recordToolEnd(toolCallId: string): { fp: string; label: string; startedAt: number } | undefined {
    const ended = this.#liveRuns.get(toolCallId);
    this.#liveRuns.delete(toolCallId);
    if (this.#liveRuns.size === 0) {
      this.#activityLive = false;
      this.#activityStartedAt = 0;
    }
    return ended;
  }

  parentLabelForCard(fingerprint: string, result?: unknown): string {
    const details = resultDetails(result);
    const persisted = details?.["minimalActivityLabel"];
    if (details?.["minimalActivityLead"] === true && typeof persisted === "string") {
      const label = persisted.trim();
      if (label) return label;
    }
    return fingerprint === this.#activityLeadFp ? this.#activityLabel : "";
  }

  parentLabelForToolCall(toolCallId: string, fingerprint: string, result?: unknown): string {
    const persisted = this.parentLabelForCard(fingerprint, result);
    if (persisted) return persisted;
    const live = this.#liveRuns.get(toolCallId);
    return live?.fp === this.#activityLeadFp ? live.label : "";
  }

  renderActivity(message: unknown, _options: unknown, theme: unknown): Container {
    if (!this.#deps.owns() || !this.#deps.enabled()) return new Container();
    const details = activityDetailsOf(message);
    if (!details || details.kind === ACTIVITY_RECORD_KIND.settled) return new Container();
    if (!details.runId || details.runId !== this.#activityRunId || !this.#activityLive) return new Container();
    const runId = details.runId;
    return paintActivityStatus(theme, {
      label: () => (runId === this.#activityRunId ? this.#activityLabel || details.label : details.label),
      context: () => (runId === this.#activityRunId ? this.#activityContext || details.context : details.context),
      outcome: () => "",
      live: () => runId === this.#activityRunId && this.#activityLive,
      error: () => false,
      visible: () => runId === this.#activityRunId && this.#activityLive,
      fadeKey: `act:${runId}`,
    });
  }

  dispose(): void {
    this.#liveRuns.clear();
    this.clearRun();
    this.#activityApiDead = false;
  }
}
