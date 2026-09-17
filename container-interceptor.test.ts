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

test("empty child filtering still calls native and preserves native exceptions", () => {
  const failure = new Error("native failed");
  class Host {
    calls = 0;
    addChild(...children: unknown[]) {
      this.calls += 1;
      expect(children).toEqual([]);
      throw failure;
    }
  }
  const interceptor = getContainerInterceptor(Host);
  interceptor.registerHook(() => ({ children: [] }));
  const host = new Host();
  try {
    expect(() => host.addChild("hidden HUD")).toThrow(failure);
    expect(host.calls).toBe(1);
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
  const external = function (this: Host) {
    events.push("external");
    return oldWrapper.call(this);
  };
  Host.prototype.addChild = external;
  interceptor.dispose();
  expect(Host.prototype.addChild).toBe(external);
  const remove = interceptor.registerHook(() => {
    events.push("new");
  })!;
  try {
    oldDispose();
    new Host().addChild();
    expect(events).toEqual(["new", "external", "native"]);
    remove();
    expect(Host.prototype.addChild).toBe(external);
    events.length = 0;
    new Host().addChild();
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
    expect(new Host().addChild()).toBe("external");
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
