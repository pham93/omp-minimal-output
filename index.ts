import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Container } from "@oh-my-pi/pi-tui";
import { acquireRuntimeOwner } from "./core/runtime-owner.ts";
import { getContainerInterceptor } from "./core/container-interceptor.ts";
import { getPluginConfig, reloadPluginConfig, wrapTool, isWrappedTool } from "./core/config.ts";
import { AnimationPump } from "./core/animation-pump.ts";
import { ActivityTracker, ACTIVITY_LABEL_SOURCE } from "./core/activity-tracker.ts";
import {
  ToolWrapper,
  isCollapseTarget,
  spillToolOutput,
  textItemOf,
  pruneMcpEnvelopes,
  unwrapResultEnvelope,
  intentFromEvent,
  intentFromAssistantMessage,
  summarizeEvent,
  nativeToolCardSkinActive,
} from "./core/tool-wrapper.ts";
import { GroupedToolManager } from "./cards/grouped-tool-card.ts";
import { ThinkingWidget, extractThinking } from "./surfaces/thinking-widget.ts";
import { TodoWidget, parseTodoResult, todoRawText } from "./surfaces/todo-widget.ts";
import { registerPluginCommands } from "./surfaces/commands.ts";
import { renderSkillPrompt } from "./surfaces/skill-prompt-renderer.ts";
import { runPluginDemo } from "./surfaces/demo-showcase.ts";
import {
  registerMinimalComposerShapes,
  installMinimalPromptEditor,
  updateMinimalPromptEditorProviders,
  createPlanStatusProvider,
  type MinimalWorkingStatus,
} from "./surfaces/composer-shapes.ts";
import { installReadGroupSkin } from "./surfaces/read-group.ts";
import { commentaryStatusFromMessage, installAssistantCommentarySkin } from "./surfaces/assistant-commentary-skin.ts";
import { openInspectOverlay } from "./surfaces/inspect-overlay.ts";
import {
  genericNativeDensityEligible,
  installNativeToolCardSkin,
  resetNativeToolCardPump,
  nativeToolCardsNeedPump,
} from "./cards/native-tool-card-skin.ts";
import { installWarningSkin, alertSkinActive, invalidateLiveAlerts } from "./surfaces/warning-skin.ts";
import { installTodoChrome } from "./surfaces/todo-hud.ts";
import { parseTodoPhases, renderDensityTodoHeader } from "./surfaces/todos-header.ts";
import { renderWriteCard, writeCardsNeedPump } from "./cards/write-card.ts";
import { eventFingerprint, stashFullText } from "./core/results.ts";
import { collapseToolText } from "./core/filters.ts";
import { toolActionLabel } from "./core/text.ts";
import { anySettling, markSettling } from "./core/theme.ts";

export default function (pi: ExtensionAPI) {
  registerMinimalComposerShapes(pi);

  if (typeof (pi as { registerAssistantThinkingRenderer?: unknown }).registerAssistantThinkingRenderer === "function") {
    try {
      (
        pi as {
          registerAssistantThinkingRenderer: (fn: (...a: unknown[]) => unknown) => void;
        }
      ).registerAssistantThinkingRenderer(() => undefined);
    } catch {
      // Older hosts without this hook keep hideThinkingBlock + the widget path.
    }
  }

  let activated = false;
  let startSession: ((ctx: ExtensionContext) => Promise<void>) | undefined;

  const ensureActivated = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI || activated) return;
    activated = true;
    startSession ??= activateInteractiveRuntime(pi);
    await startSession(ctx);
  };

  const commandHandle = registerPluginCommands(pi, ensureActivated);

  pi.on("session_start", async (_event, ctx) => {
    await ensureActivated(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    await ensureActivated(ctx);
  });
  pi.on("turn_start", async (_event, ctx) => {
    await ensureActivated(ctx);
  });
  pi.on("tool_execution_start", async (_event, ctx) => {
    await ensureActivated(ctx);
  });
  pi.on("message_update", async (_event, ctx) => {
    await ensureActivated(ctx);
  });
  pi.on("input", async (_event, ctx) => {
    await ensureActivated(ctx);
  });

  function activateInteractiveRuntime(api: ExtensionAPI): (ctx: ExtensionContext) => Promise<void> {
    const runtimeOwner = acquireRuntimeOwner();
    let enabled = true;
    let readGroupTheme: unknown;
    let disposeMinimalPromptEditor = (): void => {};
    let sessionContext: unknown;

    let kickAlertPump = (): void => {};
    let kickTodoPump = (): void => {};

    const activityTracker = new ActivityTracker({
      pi: api,
      owns: runtimeOwner.owns,
      enabled: () => enabled,
    });

    const groupedTools = new GroupedToolManager({
      rowIsLive: (fp) => {
        for (const value of activityTracker.liveRuns.values()) {
          if (value.fp === fp) return true;
        }
        return false;
      },
      activityLabel: () => activityTracker.activityLabel,
      activityRunId: () => activityTracker.activityRunId,
      activityStartedAt: () => activityTracker.getEarliestStartedAt(),
      getSessionContext: () => sessionContext,
    });

    const thinkingWidget = new ThinkingWidget({
      owns: runtimeOwner.owns,
      activityRunId: () => activityTracker.activityRunId,
      onSyncThought: (fp, thought) => {
        groupedTools.upsertGroupRow(fp, thought);
      },
    });

    const todoWidget = new TodoWidget({
      owns: runtimeOwner.owns,
      kickPump: () => kickTodoPump(),
    });

    const pump = new AnimationPump({
      owns: runtimeOwner.owns,
      onTick: () => {
        if (alertSkinActive()) invalidateLiveAlerts();
      },
      hasFastAnimation: () => {
        return (
          activityTracker.liveRunsCount !== 0 ||
          nativeToolCardsNeedPump() ||
          alertSkinActive() ||
          anySettling() ||
          writeCardsNeedPump() ||
          thinkingWidget.isAnimating() ||
          todoWidget.hasFastAnimation()
        );
      },
      isIdle: () => {
        return !(
          activityTracker.activityLive ||
          thinkingWidget.live ||
          thinkingWidget.isAnimating() ||
          activityTracker.liveRunsCount !== 0 ||
          nativeToolCardsNeedPump() ||
          alertSkinActive() ||
          anySettling() ||
          writeCardsNeedPump() ||
          todoWidget.needsPump()
        );
      },
    });

    const toolWrapper = new ToolWrapper(api, {
      owns: runtimeOwner.owns,
      enabled: () => enabled,
      activityTracker,
      groupedTools,
    });

    kickAlertPump = () => {
      const ctx = pump.getCtx();
      if (ctx !== undefined) pump.ensureTimer(ctx);
    };
    kickTodoPump = () => {
      const ctx = pump.getCtx();
      if (ctx !== undefined && todoWidget.needsPump()) pump.ensureTimer(ctx);
    };

    const containerInterceptor = getContainerInterceptor(Container);
    function installContainerSkins(): () => void {
      const disposeReadGroupSkin = installReadGroupSkin(containerInterceptor, {
        enabled: () => runtimeOwner.owns() && enabled && wrapTool("read"),
        theme: () => readGroupTheme,
        active: runtimeOwner.owns,
      });

      const disposeAssistantCommentarySkin = installAssistantCommentarySkin(containerInterceptor, {
        enabled: () => runtimeOwner.owns() && enabled,
        active: runtimeOwner.owns,
        thoughtDuration: () => thinkingWidget.lastThoughtDuration,
      });

      const disposeNativeToolCardSkin = installNativeToolCardSkin(containerInterceptor, {
        enabled: (kind) => runtimeOwner.owns() && nativeToolCardSkinActive(kind, enabled),
        genericEnabled: (toolName) => runtimeOwner.owns() && enabled && genericNativeDensityEligible(toolName),
        theme: () => readGroupTheme,
        pump: () => kickAlertPump(),
        parentLabel: (toolCallId, fingerprint, result) =>
          activityTracker.parentLabelForToolCall(toolCallId, fingerprint, result),
        active: () => runtimeOwner.owns() && enabled,
      });

      const disposeWarningSkin = installWarningSkin(containerInterceptor, {
        enabled: () => runtimeOwner.owns() && enabled && getPluginConfig().todoReminderOneLine !== false,
        theme: () => readGroupTheme,
        pump: () => kickAlertPump(),
        active: runtimeOwner.owns,
      });

      const disposeTodoChrome = installTodoChrome(containerInterceptor, {
        hideHud: () => runtimeOwner.owns() && enabled && getPluginConfig().todoHud === false,
        hideCard: () => runtimeOwner.owns() && enabled && todoWidget.widgetOn,
        skinCard: () => runtimeOwner.owns() && enabled,
        active: runtimeOwner.owns,
        paintCard: (width, expanded) => {
          const state = todoWidget.peekState();
          if (!state || state.items.length === 0) return [];
          return renderDensityTodoHeader(readGroupTheme, width, state, expanded, todoWidget.todoAnim());
        },
        onHud: () => todoWidget.syncFromSession(),
        onTodoDetails: (details) => {
          if (!todoWidget.sessionVisible) return;
          const next = parseTodoPhases(details);
          if (next) todoWidget.applyState(next);
        },
      });
      return () => {
        disposeTodoChrome();
        disposeWarningSkin();
        disposeNativeToolCardSkin();
        disposeAssistantCommentarySkin();
        disposeReadGroupSkin();
        containerInterceptor.dispose();
      };
    }
    let disposeContainerSkins = installContainerSkins();

    const PUMP_WIDGET_KEY = "minimal-pump";
    function grabTui(ctx: unknown): void {
      thinkingWidget.bindUi(ctx);
      todoWidget.bindUi(ctx);
      todoWidget.bindSource(ctx);
      if (typeof ctx === "object" && ctx !== null && "ui" in ctx) {
        const ui = (ctx as { ui?: unknown }).ui;
        if (ui && typeof ui === "object" && typeof (ui as { setWidget?: unknown }).setWidget === "function") {
          try {
            (ui as { setWidget: (key: string, fn: unknown) => void }).setWidget(PUMP_WIDGET_KEY, (tui: unknown) => {
              pump.bindUi(tui);
              thinkingWidget.setTui(tui);
              const c = new Container();
              c.addChild({ render: (): readonly string[] => [] });
              return c;
            });
          } catch {
            // Widget setup is best-effort.
          }
        }
      }
    }

    api.registerMessageRenderer("minimal-activity", (message, options, theme) => {
      return activityTracker.renderActivity(message, options, theme);
    });

    api.registerMessageRenderer("skill_prompt", (message, options, theme) => {
      return renderSkillPrompt(message, options, theme, runtimeOwner.owns);
    });

    runtimeOwner.setCleanup(() => {
      enabled = false;
      activityTracker.dispose();
      thinkingWidget.dispose();
      todoWidget.dispose();
      pump.dispose();
      toolWrapper.clear();
      groupedTools.clear();
      disposeContainerSkins();
      disposeMinimalPromptEditor();
      disposeMinimalPromptEditor = (): void => {};
    });

    function createWorkingStatusProvider(): () => MinimalWorkingStatus | undefined {
      return () => {
        try {
          const live =
            activityTracker.activityRunId !== null &&
            (activityTracker.activityLive || activityTracker.liveRunsCount > 0) &&
            activityTracker.getEarliestStartedAt() > 0;
          if (!live) return undefined;
          return { startedAt: activityTracker.getEarliestStartedAt() };
        } catch {
          return undefined;
        }
      };
    }

    let loaded = false;
    async function startSession(ctx: ExtensionContext): Promise<void> {
      if (!runtimeOwner.owns()) return;
      sessionContext = ctx;
      resetNativeToolCardPump();
      if (loaded) return;
      loaded = true;
      todoWidget.resetSessionState();
      reloadPluginConfig();
      thinkingWidget.bindUi(ctx);
      todoWidget.bindUi(ctx);
      todoWidget.bindSource(ctx);
      todoWidget.sessionVisible = true;
      todoWidget.syncFromSession(ctx);
      try {
        const maybeTheme = (ctx as unknown as { ui?: { theme?: unknown } })?.ui?.theme;
        if (maybeTheme !== undefined) readGroupTheme = maybeTheme;
      } catch {
        // Theme read is best-effort.
      }
      toolWrapper.wrapAllTools();
      if (ctx.hasUI) {
        disposeMinimalPromptEditor = installMinimalPromptEditor(
          ctx.ui,
          () => {
            try {
              return ctx.getContextUsage();
            } catch {
              return undefined;
            }
          },
          createPlanStatusProvider(ctx),
          createWorkingStatusProvider(),
        );
      }
      grabTui(ctx);
      pump.ensureTimer(ctx);
      try {
        if (enabled && ctx.hasUI) ctx.ui.notify("Minimal output active (grok-build style)", "info");
      } catch {
        // notify is best-effort chrome.
      }
    }

    api.on("session_switch", async (_event, ctx) => {
      if (!runtimeOwner.owns()) return;
      sessionContext = ctx;
      todoWidget.agentRunning = false;
      todoWidget.resetSessionState();
      todoWidget.bindUi(ctx);
      todoWidget.bindSource(ctx);
      todoWidget.sessionVisible = true;
      todoWidget.syncFromSession(ctx);
      updateMinimalPromptEditorProviders(
        () => {
          try {
            return ctx.getContextUsage();
          } catch {
            return undefined;
          }
        },
        createPlanStatusProvider(ctx),
        createWorkingStatusProvider(),
      );
      pump.stopIfIdle(ctx);
    });

    api.on("before_agent_start", async (_event, ctx) => {
      if (!runtimeOwner.owns()) return;
      sessionContext = ctx;
      todoWidget.agentRunning = true;
      todoWidget.sessionVisible = true;
      todoWidget.syncFromSession(ctx);
      pump.ensureTimer(ctx);
      if (todoWidget.headerState) todoWidget.refreshWidget();
      reloadPluginConfig();
      toolWrapper.wrapAllTools();
      updateMinimalPromptEditorProviders(
        () => {
          try {
            return ctx.getContextUsage();
          } catch {
            return undefined;
          }
        },
        createPlanStatusProvider(ctx),
        createWorkingStatusProvider(),
      );
    });

    api.on("tool_result", async (event, ctx) => {
      if (!runtimeOwner.owns() || !enabled) return undefined;
      try {
        todoWidget.bindSource(ctx);
        const prevDetails = "details" in event ? event.details : undefined;
        if (typeof event.toolName === "string" && event.toolName.toLowerCase().includes("todo")) {
          todoWidget.sessionVisible = true;
          try {
            const next =
              parseTodoPhases("details" in event ? event.details : undefined) ??
              parseTodoResult(todoRawText(event.content));
            if (next) todoWidget.applyState(next);
            else todoWidget.syncFromSession(ctx);
          } catch {
            // Stale cache stays.
          }
        }
        const resultFp = eventFingerprint(event);
        const frozen = toolWrapper.frozenGroupKeys(event.toolName);
        const withFrozen = (details: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
          if (Object.keys(frozen).length === 0) return details;
          return { ...(details ?? {}), ...frozen };
        };
        const lead =
          activityTracker.activityLabel &&
          activityTracker.parentLabelForCard(resultFp) === activityTracker.activityLabel
            ? { minimalActivityLead: true, minimalActivityLabel: activityTracker.activityLabel }
            : undefined;
        const withLead = (details: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
          if (!lead) return details;
          return { ...(details ?? {}), ...lead };
        };
        if (!isCollapseTarget(event, enabled)) {
          if (!lead) return undefined;
          return { details: withLead(withFrozen(stashFullText(prevDetails, ""))) };
        }
        const found = textItemOf(event.content);
        if (!found) {
          if (!lead) return undefined;
          return { details: withLead(withFrozen(stashFullText(prevDetails, ""))) };
        }
        const original = found.item.text as string;
        const isMcp = event.toolName.startsWith("mcp__") || event.toolName.includes("/");
        const raw = isMcp ? (unwrapResultEnvelope(original) ?? original) : original;
        const result = collapseToolText(event.toolName, event.input, raw);
        const pruned = isMcp ? pruneMcpEnvelopes(found.list, found.item, raw) : found.list;
        const droppedDupes = pruned.length !== found.list.length;
        if (!result.changed && !droppedDupes && !lead) return undefined;
        let finalText = result.changed ? result.text : original;
        if (result.changed && result.rule.split(",").includes("truncate")) {
          const path = await spillToolOutput(event.toolName, raw);
          finalText += `\n[Output truncated: ${raw.length}→${result.text.length} chars, rule=${result.rule}. Full output: ${path ?? "spill failed"}]`;
        }
        const details = withLead(withFrozen(stashFullText(prevDetails, raw)));
        if (!result.changed && !droppedDupes) return { details };
        return {
          content: pruned.map((c) => (c === found.item ? { ...c, text: finalText } : c)),
          details,
        };
      } catch {
        return undefined;
      }
    });
    api.on("tool_execution_start", async (event, ctx) => {
      if (!runtimeOwner.owns() || !enabled) return;
      sessionContext = ctx;
      const startedAt = Date.now();
      const fp = eventFingerprint(event);
      const toolName =
        typeof (event as { toolName?: unknown }).toolName === "string"
          ? (event as { toolName: string }).toolName
          : "tool";
      const args = (event as { input?: unknown; args?: unknown }).input ?? (event as { args?: unknown }).args;
      const eventIntent = intentFromEvent(event);
      const intent = eventIntent ?? (activityTracker.activityLabel || summarizeEvent(event));
      const source = eventIntent
        ? ACTIVITY_LABEL_SOURCE.tool
        : activityTracker.activityRunId !== null
          ? activityTracker.activityLabelSource
          : ACTIVITY_LABEL_SOURCE.generated;

      activityTracker.applyIntent(intent, startedAt, source);
      const isLead = activityTracker.liveRunsCount === 0;
      activityTracker.recordToolStart(event.toolCallId, fp, intent, startedAt, isLead);

      toolWrapper.tryWrapTool(toolName);
      if (toolWrapper.toolUsesGroupedStatus(toolName)) {
        groupedTools.upsertGroupRow(fp, {
          body: toolActionLabel(toolName, args),
          live: true,
          error: false,
          right: "",
          startedAt,
          details: [],
        });
      }
      pump.ensureTimer(ctx);
      thinkingWidget.live = false;
      pump.requestRepaint();
    });

    api.on("tool_execution_end", async (event, ctx) => {
      if (!runtimeOwner.owns() || !enabled) return;
      if (typeof event.toolName === "string" && event.toolName.toLowerCase().includes("todo")) {
        todoWidget.syncFromSession(ctx);
      }
      const ended = activityTracker.recordToolEnd(event.toolCallId);
      if (ended) markSettling(ended.fp);
      if (activityTracker.liveRunsCount === 0) {
        if (activityTracker.activityRunId !== null) markSettling(`act:${activityTracker.activityRunId}`);
        activityTracker.maybeSendSettledActivity();
      }
      pump.requestRepaint();
      if (writeCardsNeedPump()) pump.ensureTimer(ctx);
      pump.stopIfIdle(ctx);
    });

    api.on("message_update", async (event, ctx) => {
      if (!runtimeOwner.owns() || !enabled) return;
      sessionContext = ctx;
      thinkingWidget.bindUi(ctx);

      const streamType = (event.assistantMessageEvent as { type?: unknown })?.type;
      const commentary =
        streamType === "toolcall_start" || streamType === "toolcall_end"
          ? commentaryStatusFromMessage(event.message)
          : undefined;
      const toolIntent = intentFromAssistantMessage(event.message);
      const next = commentary ?? toolIntent;
      if (next) {
        activityTracker.applyIntent(
          next,
          Date.now(),
          commentary ? ACTIVITY_LABEL_SOURCE.commentary : ACTIVITY_LABEL_SOURCE.tool,
        );
        pump.ensureTimer(ctx);
      }

      const thinking = extractThinking(event.message);
      if (thinking.text) thinkingWidget.text = thinking.text;
      if (thinking.live) {
        thinkingWidget.live = true;
        if (!activityTracker.activityRunId || (!activityTracker.activityLive && activityTracker.liveRunsCount === 0)) {
          activityTracker.applyIntent("Working", Date.now(), ACTIVITY_LABEL_SOURCE.generated);
        }
        if (thinkingWidget.startedAt === 0) thinkingWidget.startedAt = Date.now();
        thinkingWidget.syncThought();
        thinkingWidget.installWidget();
        pump.ensureTimer(ctx);
      } else if (thinkingWidget.live) {
        thinkingWidget.live = false;
        thinkingWidget.syncThought();
        pump.requestRepaint();
      } else if (thinkingWidget.widgetOn) {
        pump.requestRepaint();
      }
    });

    api.on("turn_start", async (_event, ctx) => {
      if (!runtimeOwner.owns() || !enabled) return;
      sessionContext = ctx;
      todoWidget.agentRunning = true;
      activityTracker.startTurn();
      reloadPluginConfig();
      toolWrapper.wrapAllTools();
      thinkingWidget.bindUi(ctx);
      todoWidget.bindUi(ctx);
      todoWidget.bindSource(ctx);
      todoWidget.sessionVisible = true;
      todoWidget.syncFromSession(ctx);
      pump.ensureTimer(ctx);
    });

    api.on("agent_end", async (_event, ctx) => {
      if (!runtimeOwner.owns()) return;
      todoWidget.agentRunning = false;
      if (thinkingWidget.live) {
        thinkingWidget.live = false;
        thinkingWidget.syncThought();
      }
      activityTracker.maybeSendSettledActivity(true);
      activityTracker.clearRun();
      thinkingWidget.reset();
      todoWidget.refreshWidget();
      pump.stopIfIdle(ctx);
    });

    api.on("turn_end", async (_event, ctx) => {
      if (!runtimeOwner.owns() || !enabled) return;
      todoWidget.agentRunning = false;
      if (thinkingWidget.live) {
        thinkingWidget.live = false;
        thinkingWidget.syncThought();
      }
      activityTracker.maybeSendSettledActivity();
      activityTracker.clearRun();
      thinkingWidget.reset();
      pump.stopIfIdle(ctx);
      reloadPluginConfig();
      todoWidget.syncFromSession(ctx);
    });
    commandHandle.setDelegates({
      minimalOn: (_ctx) => {
        if (!runtimeOwner.owns()) return;
        if (!enabled) disposeContainerSkins = installContainerSkins();
        enabled = true;
        activityTracker.clearRun();
        todoWidget.installWidget();
        _ctx.ui.notify("Minimal output enabled", "info");
      },
      minimalOff: (_ctx) => {
        if (!runtimeOwner.owns()) return;
        activityTracker.maybeSendSettledActivity(true);
        enabled = false;
        disposeContainerSkins();
        resetNativeToolCardPump();
        activityTracker.clearRun();
        todoWidget.setWidget(false);
        thinkingWidget.reset();
        pump.stopIfIdle(_ctx);
        _ctx.ui.notify("Minimal output disabled", "warning");
      },
      todosShow: (_ctx) => {
        if (!runtimeOwner.owns()) return;
        todoWidget.sessionVisible = true;
        todoWidget.syncFromSession(_ctx);
        todoWidget.installWidget();
        const hasTodos = !!todoWidget.headerState && todoWidget.headerState.items.length > 0;
        _ctx.ui.notify(
          todoWidget.widgetOn ? "Todos shown" : hasTodos ? "Todos header is disabled" : "No todos in this session",
          "info",
        );
      },
      todos: (_ctx) => {
        if (!runtimeOwner.owns()) return;
        todoWidget.todosCollapsed = !todoWidget.todosCollapsed;
        todoWidget.refreshWidget();
        _ctx.ui.notify(todoWidget.todosCollapsed ? "Todos collapsed" : "Todos expanded", "info");
      },
      demoWrite: async (_ctx) => {
        if (!runtimeOwner.owns() || !_ctx.hasUI) return;
        await runPluginDemo(_ctx, "write");
      },
      demo: async (args, _ctx) => {
        if (!runtimeOwner.owns() || !_ctx.hasUI) return;
        await runPluginDemo(_ctx, args);
      },
      minimalStatus: (_ctx) => {
        if (!runtimeOwner.owns()) return;
        const cfg = getPluginConfig();
        const native: string[] = [];
        if (cfg.nativeBash) native.push("bash");
        if (cfg.nativeRead) native.push("read");
        if (cfg.nativeGrep) native.push("grep");
        if (cfg.nativeGlob) native.push("glob");
        if (cfg.nativeWrite) native.push("write");
        if (cfg.nativeEdit) native.push("edit");
        if (cfg.nativeEval) native.push("eval");
        if (cfg.nativeWebSearch) native.push("web_search");
        if (cfg.nativeTask) native.push("task");
        if (cfg.nativeHub) native.push("hub");
        _ctx.ui.notify(
          `Minimal output: ${enabled ? "on" : "off"} (collapsed rows, shimmer disabled) opacity=${cfg.opacity} indicator=${cfg.indicator} anim=${cfg.indicatorAnimation ? "on" : "off"} native=[${native.join(",")}] searchMax=${cfg.webSearchMaxResults} taskMax=${cfg.taskMaxAgents} hubMax=${cfg.hubMaxItems} tabs=${cfg.editShowTabs ? "on" : "off"} spaces=${cfg.editShowSpaces ? "on" : "off"} reminder=${cfg.todoReminderOneLine !== false ? "on" : "off"}`,
          "info",
        );
      },
      toggleTodosShortcut: (_ctx) => {
        if (!runtimeOwner.owns()) return;
        todoWidget.todosCollapsed = !todoWidget.todosCollapsed;
        todoWidget.refreshWidget();
      },
      inspect: async (ctx) => {
        if (!runtimeOwner.owns()) return;
        await openInspectOverlay(ctx, readGroupTheme);
      },
    });

    api.on("session_shutdown", async () => {
      if (!runtimeOwner.owns()) return;
      runtimeOwner.release();
    });

    return startSession;
  }
}
