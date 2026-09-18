import { describe, expect, mock, test } from "bun:test";

class MockContainer {
  children: Array<{ render?: (width: number) => readonly string[] }> = [];
  addChild(child: { render?: (width: number) => readonly string[] }) {
    this.children.push(child);
  }
}

mock.module("@oh-my-pi/pi-tui", () => ({
  Container: MockContainer,
  visibleWidth: (s: string) => Bun.stripANSI(s).length,
  padding: (w: number) => " ".repeat(Math.max(0, w)),
  sliceByColumn: (s: string, start: number, len: number) => s.slice(start, start + len),
  truncateToWidth: (s: string, w: number) => s.slice(0, w),
  matchesKey: (data: string, key: string) => data === key,
}));
// Dynamic import: mock.module() above must execute before core/animation-pump.ts loads.
const { AnimationPump, ANIMATION_FAST_MS, ANIMATION_SLOW_MS } = await import("./core/animation-pump.ts");
const { todoHasActiveTransition } = await import("./surfaces/todos-header.ts");

describe("AnimationPump adaptive cadence", () => {
  test("uses fast cadence (120ms) when fast animation is requested", () => {
    let fast = true;
    let idle = false;
    const intervals: number[] = [];

    const fakeCtx = {
      setInterval: (_fn: () => void, ms: number) => {
        intervals.push(ms);
        return 123;
      },
      clearInterval: () => {},
    };

    const pump = new AnimationPump({
      owns: () => true,
      hasFastAnimation: () => fast,
      isIdle: () => idle,
    });

    pump.ensureTimer(fakeCtx);
    expect(pump.hasTimer()).toBe(true);
    expect(pump.currentIntervalMs()).toBe(ANIMATION_FAST_MS);
    expect(intervals).toEqual([ANIMATION_FAST_MS]);
  });

  test("uses slow cadence (1000ms) when fast animation is not requested but not idle", () => {
    let fast = false;
    let idle = false;
    const intervals: number[] = [];

    const fakeCtx = {
      setInterval: (_fn: () => void, ms: number) => {
        intervals.push(ms);
        return 123;
      },
      clearInterval: () => {},
    };

    const pump = new AnimationPump({
      owns: () => true,
      hasFastAnimation: () => fast,
      isIdle: () => idle,
    });

    pump.ensureTimer(fakeCtx);
    expect(pump.hasTimer()).toBe(true);
    expect(pump.currentIntervalMs()).toBe(ANIMATION_SLOW_MS);
    expect(intervals).toEqual([ANIMATION_SLOW_MS]);
  });

  test("upgrades from slow to fast immediately when fast animation starts", () => {
    let fast = false;
    let idle = false;
    const intervals: number[] = [];
    let clearedCount = 0;

    const fakeCtx = {
      setInterval: (_fn: () => void, ms: number) => {
        intervals.push(ms);
        return intervals.length;
      },
      clearInterval: () => {
        clearedCount++;
      },
    };

    const pump = new AnimationPump({
      owns: () => true,
      hasFastAnimation: () => fast,
      isIdle: () => idle,
    });

    // Initial passive state (1000ms)
    pump.ensureTimer(fakeCtx);
    expect(pump.currentIntervalMs()).toBe(ANIMATION_SLOW_MS);

    // Fast animation starts (e.g. tool execution starts)
    fast = true;
    pump.ensureTimer(fakeCtx);
    expect(pump.currentIntervalMs()).toBe(ANIMATION_FAST_MS);
    expect(clearedCount).toBe(1);
    expect(intervals).toEqual([ANIMATION_SLOW_MS, ANIMATION_FAST_MS]);
  });

  test("does not start timer and clears when idle", () => {
    let fast = false;
    let idle = true;
    let cleared = false;

    const fakeCtx = {
      setInterval: () => 123,
      clearInterval: () => {
        cleared = true;
      },
    };

    const pump = new AnimationPump({
      owns: () => true,
      hasFastAnimation: () => fast,
      isIdle: () => idle,
    });

    pump.ensureTimer(fakeCtx);
    expect(pump.hasTimer()).toBe(false);
  });

  test("stopIfIdle switches from fast to slow when fast animation ends", () => {
    let fast = true;
    let idle = false;
    const intervals: number[] = [];

    const fakeCtx = {
      setInterval: (_fn: () => void, ms: number) => {
        intervals.push(ms);
        return intervals.length;
      },
      clearInterval: () => {},
    };

    const pump = new AnimationPump({
      owns: () => true,
      hasFastAnimation: () => fast,
      isIdle: () => idle,
    });

    pump.ensureTimer(fakeCtx);
    expect(pump.currentIntervalMs()).toBe(ANIMATION_FAST_MS);

    // Fast animation ends (e.g. tool and settling finished)
    fast = false;
    pump.stopIfIdle(fakeCtx);
    expect(pump.currentIntervalMs()).toBe(ANIMATION_SLOW_MS);
    expect(intervals).toEqual([ANIMATION_FAST_MS, ANIMATION_SLOW_MS]);
  });

  test("todoHasActiveTransition detects active completion animations", () => {
    const completingMap = new Map<string, number>();
    const now = 10_000;

    // Empty
    expect(todoHasActiveTransition(completingMap, now)).toBe(false);

    // Item completing within 600ms
    completingMap.set("task-1", now - 200);
    expect(todoHasActiveTransition(completingMap, now)).toBe(true);

    // Item completed past 600ms
    completingMap.set("task-1", now - 700);
    expect(todoHasActiveTransition(completingMap, now)).toBe(false);
  });
});
