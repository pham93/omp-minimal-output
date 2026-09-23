import { afterAll, describe, expect, mock, test } from "bun:test";

/*
 * The native TODO HUD is hidden by a container-interceptor hook. Host 18.2.9 renamed its container
 * class and moved the tree rows into the banner Text, which silently un-hid the HUD — nothing covered
 * this skin, so nothing caught it. These cases pin identity for both host shapes and guard the
 * over-hide risk (a container that merely contains the word TODO, or holds widgets).
 */
mock.module("@oh-my-pi/pi-tui", () => ({
  Container: class {
    children: unknown[] = [];
    addChild(child: unknown) {
      this.children.push(child);
    }
    render() {
      return [];
    }
  },
  visibleWidth: (s: string) => Bun.stripANSI(s).length,
  padding: (w: number) => " ".repeat(Math.max(0, w)),
  sliceByColumn: (s: string, start: number, len: number) => s.slice(start, start + len),
  truncateToWidth: (s: string, w: number) => s.slice(0, w),
  matchesKey: (data: string, key: string) => data === key,
}));

const { installTodoChrome, isTodoHudBanner } = await import("./surfaces/todo-hud.ts");

/** A host Text: identity is the `getText` method plus the rendered lines. */
function hostText(lines: readonly string[]) {
  return { getText: () => lines.join("\n"), render: () => [...lines] };
}

class Host {
  children: unknown[] = [];
  addChild(...children: unknown[]) {
    this.children.push(...children);
  }
  render() {
    return [] as string[];
  }
}

// `installTodoChrome` is once-per-process and its hook re-reads `hideHud` on every insertion, so the
// file shares one install and flips the flag per case.
let hideFlag = true;
let hideCardFlag = false;
const PAINTED = "Painted todo card";
const dispose = installTodoChrome(Host, {
  hideHud: () => hideFlag,
  hideCard: () => hideCardFlag,
  skinCard: () => true,
  paintCard: () => [PAINTED],
  active: () => true,
});
afterAll(() => dispose());

describe("native TODO HUD identity", () => {
  test("18.2.9 shape: the banner Text carries the tree rows", () => {
    expect(isTodoHudBanner(hostText(["", "TODO ├─ first └─ second"]))).toBe(true);
  });

  test("older shape: a banner line on its own", () => {
    expect(isTodoHudBanner(hostText(["", "TODO"]))).toBe(true);
  });

  test("the compact status line variant counts as the HUD", () => {
    expect(isTodoHudBanner(hostText(["TODO 3/7 · next task"]))).toBe(true);
  });

  test("transcript text is not a HUD banner", () => {
    for (const lines of [
      ["Todo"],
      ["// TODO: token"],
      ["TODO: implement this"],
      ["- [ ] TODO"],
      [""],
      // Plain prose/code that merely starts with the word: an all-text container carrying this must
      // not be dropped, or the transcript would lose the line.
      ["TODO fix later"],
      ["TODO write the docs"],
      ["TODO 3 items left"],
    ]) {
      expect(isTodoHudBanner(hostText(lines)), JSON.stringify(lines)).toBe(false);
    }
    expect(isTodoHudBanner({ render: () => [] })).toBe(false);
  });
});

describe("the HUD container is identified by structure, not only by class name", () => {
  // The hook runs on the parent receiving children, so the HUD is hidden by refusing the banner
  // insertion into its container — 18.2.9 adds exactly one Text, older hosts add the banner too.
  // `Host` is not named TodoHudContainer, so every case here exercises the structural rule.
  test("a container receiving only the banner refuses it", () => {
    hideFlag = true;
    const hud = new Host();
    hud.addChild(hostText(["", "TODO ├─ a"]));
    expect(hud.children).toEqual([]);
  });

  test("the legacy class name is still recognised", async () => {
    const { isTodoHudContainer } = await import("./surfaces/todo-hud.ts");
    class TodoHudContainer {}
    expect(isTodoHudContainer(new TodoHudContainer())).toBe(true);
    expect(isTodoHudContainer(new Host())).toBe(false);
  });

  test("a mixed insertion is left alone", () => {
    hideFlag = true;
    const hud = new Host();
    hud.addChild(hostText(["", "TODO ├─ a"]), { render: () => [] as string[] });
    expect(hud.children).toHaveLength(2);
  });

  test("a transcript card mentioning TODO keeps its text", () => {
    hideFlag = true;
    const card = new Host();
    card.addChild(hostText(["// TODO: token"]));
    expect(card.children).toHaveLength(1);
  });

  test("hideHud false leaves the HUD in place", () => {
    hideFlag = false;
    const hud = new Host();
    hud.addChild(hostText(["", "TODO ├─ a"]));
    expect(hud.children).toHaveLength(1);
  });
});

describe("the transcript todo card is skinned, and only when it is a todo", () => {
  /** A host ToolExecutionComponent: the methods `isTodoCardHost` requires, and nothing else. */
  function hostToolCard(native: readonly string[] = ["native row"]) {
    const card = {
      rows: [...native],
      updateResult(_result: unknown) {},
      setExpanded(_expanded: boolean) {},
      seal() {},
      canBeDisplacedBy: () => true,
      isDisplaceableBlock: () => true,
      render: () => [...card.rows],
    };
    return card;
  }

  const todoResult = { details: { phases: [{ name: "Work", tasks: [] }] } };

  test("a todo result takes over the card's rows", () => {
    hideCardFlag = false;
    const parent = new Host();
    const card = hostToolCard();
    parent.addChild(card);
    card.updateResult(todoResult);
    expect(card.render()).toEqual([PAINTED]);
  });

  test("a non-todo result keeps the native rows", () => {
    hideCardFlag = false;
    const parent = new Host();
    const card = hostToolCard();
    parent.addChild(card);
    card.updateResult({ details: { output: "not a todo" } });
    expect(card.render()).toEqual(["native row"]);
  });

  test("hideCard drops the transcript card entirely", () => {
    hideCardFlag = true;
    const parent = new Host();
    const card = hostToolCard();
    parent.addChild(card);
    card.updateResult(todoResult);
    expect(card.render()).toEqual([]);
    hideCardFlag = false;
  });

  test("a component without the ToolExecutionComponent shape is not skinned", () => {
    hideCardFlag = false;
    const parent = new Host();
    const card = hostToolCard();
    // A read-group host: same render/updateResult pair, but `removeEntry` marks it.
    (card as Record<string, unknown>)["removeEntry"] = () => {};
    parent.addChild(card);
    card.updateResult(todoResult);
    expect(card.render()).toEqual(["native row"]);
  });
});
