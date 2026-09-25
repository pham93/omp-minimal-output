import { expect, test } from "bun:test";
import { getContainerInterceptor } from "./core/container-interceptor.ts";

test("hooks preserve nested order, fail open, and delegate native insertion exactly once", () => {
  const events: string[] = [];
  const sentinel = {};
  class Host {
    calls = 0;
    children: unknown[] = [];
    addChild(...children: unknown[]) {
      this.calls += 1;
      this.children.push(...children);
      events.push("native");
      return sentinel;
    }
  }
  const native = Host.prototype.addChild;
  const interceptor = getContainerInterceptor(Host);
  const first = interceptor.registerHook((parent, children) => {
    expect(parent).toBe(host);
    events.push("first");
    expect(children).toEqual(["visible"]);
  })!;
  const failing = interceptor.registerHook(() => {
    events.push("failing");
    throw new Error("skin failed");
  })!;
  const last = interceptor.registerHook(() => {
    events.push("last");
    return { children: ["visible"] };
  })!;
  const host = new Host();
  try {
    expect(host.addChild("original")).toBe(sentinel);
    expect(host.children).toEqual(["visible"]);
    expect(host.calls).toBe(1);
    expect(events).toEqual(["last", "failing", "first", "native"]);
    first();
    last();
    failing();
    expect(Host.prototype.addChild).toBe(native);
  } finally {
    interceptor.dispose();
  }
});

test("dropping every child inserts nothing, never a hole", () => {
  // Mirrors the host's arity: `addChild(e) { this.children.push(e); }` pushes whatever it receives,
  // so delegating a dropped row as a zero-argument call stores a literal `undefined`. The composer's
  // frame loop dereferences every chrome child (`Composer.renderFrame` → `rowTargetCandidates`), so
  // that hole takes the whole render loop down. The todo HUD is hidden exactly this way.
  class Host {
    children: unknown[] = [];
    calls = 0;
    addChild(child: unknown) {
      this.calls += 1;
      this.children.push(child);
    }
  }
  const interceptor = getContainerInterceptor(Host);
  const dropping = interceptor.registerHook(() => ({ children: [] }))!;
  const host = new Host();
  try {
    host.addChild("hidden HUD");
    host.addChild();
    expect(host.calls).toBe(0);
    expect(host.children).toStrictEqual([]);

    dropping();
    interceptor.registerHook(() => {});
    host.addChild("kept");
    expect(host.calls).toBe(1);
    expect(host.children).toEqual(["kept"]);
  } finally {
    interceptor.dispose();
  }
});

test("native insertion failures still propagate for kept children", () => {
  const failure = new Error("native failed");
  class Host {
    calls = 0;
    addChild(child: unknown) {
      expect(child).toBe("kept");
      this.calls += 1;
      throw failure;
    }
  }
  const interceptor = getContainerInterceptor(Host);
  interceptor.registerHook(() => {});
  const host = new Host();
  try {
    expect(() => host.addChild("kept")).toThrow(failure);
    expect(host.calls).toBe(1);
  } finally {
    interceptor.dispose();
  }
});

test("never hands the host an undefined or null child", () => {
  class Host {
    children: unknown[] = [];
    addChild(...children: unknown[]) {
      this.children.push(...children);
    }
  }
  const interceptor = getContainerInterceptor(Host);
  interceptor.registerHook(() => ({ children: [undefined, "kept", null] }));
  const host = new Host();
  try {
    // The composer's frame layout dereferences every child of its chrome
    // containers, so a non-component child must never reach native insertion.
    host.addChild("original");
    expect(host.children).toEqual(["kept"]);
  } finally {
    interceptor.dispose();
  }
});

test("ignores a hook result without a child array", () => {
  class Host {
    children: unknown[] = [];
    addChild(...children: unknown[]) {
      this.children.push(...children);
    }
  }
  const interceptor = getContainerInterceptor(Host);
  interceptor.registerHook(() => ({ children: undefined }) as never);
  const host = new Host();
  try {
    host.addChild("kept");
    expect(host.children).toEqual(["kept"]);
  } finally {
    interceptor.dispose();
  }
});

test("disposal leaves external wrappers intact and reinstallation never revives old hooks", () => {
  const events: string[] = [];
  class Host {
    addChild() {
      events.push("native");
    }
  }
  const interceptor = getContainerInterceptor(Host);
  const oldDispose = interceptor.registerHook(() => {
    events.push("old");
  })!;
  const oldWrapper = Host.prototype.addChild;
  const external = function (this: Host, ...args: unknown[]) {
    events.push("external");
    return oldWrapper.call(this, ...args);
  };
  Host.prototype.addChild = external;
  interceptor.dispose();
  expect(Host.prototype.addChild).toBe(external);
  const remove = interceptor.registerHook(() => {
    events.push("new");
  })!;
  try {
    oldDispose();
    new Host().addChild("block");
    expect(events).toEqual(["new", "external", "native"]);
    remove();
    expect(Host.prototype.addChild).toBe(external);
    events.length = 0;
    new Host().addChild("block");
    expect(events).toEqual(["external", "native"]);
  } finally {
    interceptor.dispose();
  }
});

test("captures the current native method at registration, not construction", () => {
  class Host {
    addChild() {
      return "original";
    }
  }
  const interceptor = getContainerInterceptor(Host);
  const replacement = () => "external";
  Host.prototype.addChild = replacement;
  const remove = interceptor.registerHook(() => {})!;
  try {
    expect(new Host().addChild("block")).toBe("external");
  } finally {
    remove();
  }
  expect(Host.prototype.addChild).toBe(replacement);
});

test("rejected prototype mutation does not register hooks or change insertion", () => {
  class Host {
    addChild() {
      return "native";
    }
  }
  Object.freeze(Host.prototype);
  const interceptor = getContainerInterceptor(Host);
  let called = false;
  expect(
    interceptor.registerHook(() => {
      called = true;
    }),
  ).toBeUndefined();
  expect(new Host().addChild()).toBe("native");
  expect(called).toBe(false);
  interceptor.dispose();
});
