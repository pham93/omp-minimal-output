import { describe, expect, mock, test } from "bun:test";

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

const { deduplicateReadToolImages, installNativeToolCardSkin, stripToolExecutionBackground, TOOL_EXECUTION_PADDING_X } =
  await import("./cards/native-tool-card-skin.ts");
const { markFlush, tryCaptureFramedSymbol } = await import("./core/loaders.ts");
const { paintReadGroupLines } = await import("./surfaces/read-group.ts");

describe("stripToolExecutionBackground and padding enforcement", () => {
  test("neutralizes background function and enforces 1-character padding when active", () => {
    let capturedBg: unknown = "initial";
    let capturedPaddingX = -1;
    let capturedPaddingY = -1;

    const box = {
      setBgFn(fn?: (text: string) => string) {
        capturedBg = fn;
      },
      setPaddingX(px: number) {
        capturedPaddingX = px;
      },
      setPaddingY(py: number) {
        capturedPaddingY = py;
      },
      render: () => ["content"],
    };

    let active = true;
    stripToolExecutionBackground(box, { active: () => active });

    // Initial application should set bg to undefined, paddingX to 1, and paddingY to 0
    expect(capturedBg).toBeUndefined();
    expect(capturedPaddingX).toBe(TOOL_EXECUTION_PADDING_X);
    expect(capturedPaddingX).toBe(1);
    expect(capturedPaddingY).toBe(0);

    // OMP later calls setBgFn(stateBgFn) and setPaddingX(2) during #rebuildDisplay()
    const redBgFn = (t: string) => `\x1b[41m${t}\x1b[0m`;
    box.setBgFn(redBgFn);
    box.setPaddingX(2);
    box.setPaddingY(1);

    // Patched handlers must intercept and keep background undefined and paddingX at 1
    expect(capturedBg).toBeUndefined();
    expect(capturedPaddingX).toBe(1);
    expect(capturedPaddingY).toBe(0);

    // When deactivated (e.g. /minimal-off), native arguments pass through
    active = false;
    box.setBgFn(redBgFn);
    box.setPaddingX(2);
    box.setPaddingY(1);

    expect(capturedBg).toBe(redBgFn);
    expect(capturedPaddingX).toBe(2);
    expect(capturedPaddingY).toBe(1);
  });

  test("neutralizes custom background on text-like components", () => {
    let capturedCustomBg: unknown = "initial";
    const textComponent = {
      setCustomBgFn(fn?: (text: string) => string) {
        capturedCustomBg = fn;
      },
    };

    let active = true;
    stripToolExecutionBackground(textComponent, { active: () => active });

    expect(capturedCustomBg).toBeUndefined();

    const greenBgFn = (t: string) => `\x1b[42m${t}\x1b[0m`;
    textComponent.setCustomBgFn(greenBgFn);
    expect(capturedCustomBg).toBeUndefined();

    active = false;
    textComponent.setCustomBgFn(greenBgFn);
    expect(capturedCustomBg).toBe(greenBgFn);
  });

  test("captures framedBlockComponent symbol and markFlush sets it", () => {
    const sym = Symbol("framedBlockComponent");
    const sample = { [sym]: true };

    const captured = tryCaptureFramedSymbol(sample);
    expect(captured).toBe(true);

    const testCard = {};
    expect(markFlush).toBeDefined();
    markFlush?.(testCard);
    expect((testCard as Record<symbol, unknown>)[sym]).toBe(true);
  });

  test("installNativeToolCardSkin strips background from child boxes and enforces 1-character padding", () => {
    class MockContainer {
      children: unknown[] = [];
      addChild(...children: unknown[]) {
        this.children.push(...children);
        return this;
      }
    }

    class MockBox {
      paddingX = 0;
      bgFn?: (t: string) => string;
      setBgFn(fn?: (text: string) => string) {
        this.bgFn = fn;
      }
      setPaddingX(px: number) {
        this.paddingX = px;
      }
      setPaddingY() {}
      render() {
        const pad = " ".repeat(this.paddingX);
        return [`${pad}◆ Write test - 1 line`];
      }
    }

    class MockToolExecution extends MockContainer {
      render() {
        const box = this.children[0] as MockBox | undefined;
        return box ? box.render() : [];
      }
      updateArgs() {}
      setExecutionStarted() {}
      updateResult() {}
      setExpanded() {}
      seal() {}
    }

    let active = true;
    const dispose = installNativeToolCardSkin(MockContainer, {
      enabled: () => true,
      theme: () => ({}),
      active: () => active,
    });

    try {
      const toolExecution = new MockToolExecution();
      const contentBox = new MockBox();
      toolExecution.addChild(contentBox);

      // Child box should have had its background stripped and padding set to 1
      expect(contentBox.bgFn).toBeUndefined();
      expect(contentBox.paddingX).toBe(1);
      expect(contentBox.paddingX).toBe(TOOL_EXECUTION_PADDING_X);

      // Render on skinned component includes 1-character padding
      const rendered = toolExecution.render() as string[];
      expect(rendered[0]).toBe(" ◆ Write test - 1 line");

      // Later OMP update attempt to re-add background and 2-column padding
      contentBox.setBgFn((t) => `\x1b[41m${t}\x1b[0m`);
      contentBox.setPaddingX(2);

      expect(contentBox.bgFn).toBeUndefined();
      expect(contentBox.paddingX).toBe(1);
    } finally {
      dispose();
    }
  });

  test("paintReadGroupLines includes 1-character padding to align with other tool cards", () => {
    const singleLines = paintReadGroupLines(null, 100, [
      { id: "read-1", path: "src/server.ts", pending: false, error: false },
    ]).map(Bun.stripANSI);

    expect(singleLines).toHaveLength(1);
    expect(singleLines[0].startsWith(" ")).toBe(true);
    expect(singleLines[0]).toContain("Read src/server.ts");

    const multiLines = paintReadGroupLines(null, 100, [
      { id: "read-1", path: "src/server.ts", pending: false, error: false },
      { id: "read-2", path: "src/config.ts", pending: false, error: false },
    ]).map(Bun.stripANSI);

    expect(multiLines[0].startsWith(" ")).toBe(true);
    expect(multiLines[0]).toContain("Read 2 files");
    expect(multiLines[1].startsWith(" ")).toBe(true);
    expect(multiLines[2].startsWith(" ")).toBe(true);
  });
});

describe("deduplicateReadToolImages", () => {
  test("sets showImages to false on read tool execution component and restores when inactive", () => {
    let showImagesState: boolean | undefined = undefined;
    const component = {
      setShowImages(show: boolean) {
        showImagesState = show;
      },
    };
    const state = {
      args: { path: "attachment://1" },
      result: undefined,
      partial: false,
      expanded: false,
      toolCallId: "call-1",
      sealed: false,
    };
    deduplicateReadToolImages(component, state, {
      enabled: () => true,
      theme: () => null,
      active: () => true,
    });
    expect(showImagesState).toBe(false);

    // When inactive, restores showImages to true
    deduplicateReadToolImages(component, state, {
      enabled: () => true,
      theme: () => null,
      active: () => false,
    });
    expect(showImagesState).toBe(true);
  });
});
