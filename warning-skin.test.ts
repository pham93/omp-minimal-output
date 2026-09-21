// Host contract: the interactive transcript commits blocks strictly in order, so a block that
// never reports finalized pins the frontier and every later block — assistant messages included —
// is dropped from the live window and never written to scrollback. These tests pin the alert
// skin's side of that contract: pulses while the alert is the newest block, finalizes as soon as
// anything follows.
import { afterEach, describe, expect, mock, test } from "bun:test";

class MockContainer {
  children: unknown[] = [];
  addChild(...children: unknown[]) {
    this.children.push(...children);
    return this;
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

const { alertSkinActive, installWarningSkin, invalidateLiveAlerts } = await import("./surfaces/warning-skin.ts");

class FakeContainer {
  children: unknown[] = [];
  addChild(child: unknown): unknown {
    this.children.push(child);
    return child;
  }
}

interface AlertFake {
  todos: Array<{ content: string; status: string }>;
  attempt: number;
  maxAttempts: number;
  render: (width: number) => readonly string[];
  isTranscriptBlockFinalized: () => boolean;
  getTranscriptBlockVersion: () => number;
}

function makeTodoReminder(): AlertFake {
  return {
    todos: [{ content: "extract WidgetCache", status: "pending" }],
    attempt: 1,
    maxAttempts: 5,
    render: () => ["native reminder"],
    // Host default for components that do not implement finalization.
    isTranscriptBlockFinalized: () => true,
    getTranscriptBlockVersion: () => 0,
  };
}

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

describe("alert skin transcript finalization", () => {
  test("keeps the alert animatable while it is the newest block", () => {
    dispose = installWarningSkin(FakeContainer, { enabled: () => true, theme: () => undefined });
    const container = new FakeContainer();
    const alert = makeTodoReminder();
    container.addChild(alert);

    expect(alert.isTranscriptBlockFinalized()).toBe(false);
    expect(alertSkinActive()).toBe(true);
    expect(() => invalidateLiveAlerts()).not.toThrow();

    const painted = alert.render(60);
    expect(painted).toHaveLength(1);
    expect(painted[0]).toContain("⚠");
  });

  test("finalizes once any later block arrives so commits can advance", () => {
    dispose = installWarningSkin(FakeContainer, { enabled: () => true, theme: () => undefined });
    const container = new FakeContainer();
    const alert = makeTodoReminder();
    container.addChild(alert);
    expect(alert.isTranscriptBlockFinalized()).toBe(false);

    container.addChild({ render: () => ["later block"] });

    expect(alert.isTranscriptBlockFinalized()).toBe(true);
    expect(alertSkinActive()).toBe(false);
    expect(() => invalidateLiveAlerts()).not.toThrow();
  });

  test("a finalized alert never resumes pulsing when the block behind it goes away", () => {
    dispose = installWarningSkin(FakeContainer, { enabled: () => true, theme: () => undefined });
    const container = new FakeContainer();
    const alert = makeTodoReminder();
    container.addChild(alert);
    expect(alertSkinActive()).toBe(true);

    container.addChild({ render: () => ["later block"] });
    invalidateLiveAlerts();

    // The host committed the alert; removing the block that followed it must not restart the pulse.
    container.children = [alert];
    expect(alertSkinActive()).toBe(false);
  });

  test("stops pulsing after the alert leaves the container", () => {
    dispose = installWarningSkin(FakeContainer, { enabled: () => true, theme: () => undefined });
    const container = new FakeContainer();
    const alert = makeTodoReminder();
    container.addChild(alert);
    expect(alertSkinActive()).toBe(true);

    container.children = [];

    expect(alert.isTranscriptBlockFinalized()).toBe(true);
    expect(alertSkinActive()).toBe(false);
  });
});
