export type ContainerAddChildHook = (
  container: unknown,
  children: readonly unknown[],
) => { children: readonly unknown[] } | void;

type AddChild = (this: unknown, ...children: unknown[]) => unknown;
interface ContainerPrototype {
  addChild?: AddChild;
}

function prototypeOf(value: unknown): ContainerPrototype | undefined {
  try {
    if ((typeof value !== "function" && typeof value !== "object") || value === null) return;
    const prototype = (value as { prototype?: unknown }).prototype;
    if (typeof prototype !== "object" || prototype === null) return;
    return prototype as ContainerPrototype;
  } catch {
    return;
  }
}

export class ContainerInterceptor {
  readonly #prototype: ContainerPrototype | undefined;
  #hooks: ContainerAddChildHook[] = [];
  #nativeAddChild: AddChild | undefined;
  #patchedAddChild: AddChild | undefined;

  constructor(ContainerCtor: unknown) {
    this.#prototype = prototypeOf(ContainerCtor);
  }

  get isAvailable(): boolean {
    try {
      return typeof this.#prototype?.addChild === "function";
    } catch {
      return false;
    }
  }

  registerHook(hook: ContainerAddChildHook): (() => void) | undefined {
    if (!this.#patchedAddChild) {
      try {
        const prototype = this.#prototype;
        const native = prototype?.addChild;
        if (!prototype || typeof native !== "function") return;
        const hooks = this.#hooks;
        const patched: AddChild = function (...args) {
          let children: readonly unknown[] = args;
          // Match the former nested patches: the latest subscriber runs first.
          for (let index = hooks.length - 1; index >= 0; index -= 1) {
            try {
              const result = hooks[index]?.(this, children);
              if (result) children = result.children;
            } catch {
              // Skin failures must not change native insertion or error semantics.
            }
          }
          return native.apply(this, children as unknown[]);
        };
        prototype.addChild = patched;
        if (prototype.addChild !== patched) return;
        this.#nativeAddChild = native;
        this.#patchedAddChild = patched;
      } catch {
        return;
      }
    }

    const hooks = this.#hooks;
    hooks.push(hook);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = hooks.indexOf(hook);
      if (index >= 0) hooks.splice(index, 1);
      if (hooks === this.#hooks && hooks.length === 0) this.dispose();
    };
  }

  dispose(): void {
    this.#hooks.length = 0;
    try {
      if (this.#prototype && this.#prototype.addChild === this.#patchedAddChild) {
        this.#prototype.addChild = this.#nativeAddChild;
      }
    } catch {
      // Never overwrite an external extension's newer patch.
    }
    // An external patch can retain our old wrapper. Its hook list stays empty.
    this.#hooks = [];
    this.#nativeAddChild = undefined;
    this.#patchedAddChild = undefined;
  }
}

const interceptorRegistry = new WeakMap<object, ContainerInterceptor>();

export function getContainerInterceptor(ContainerCtor: unknown): ContainerInterceptor {
  if (ContainerCtor instanceof ContainerInterceptor) return ContainerCtor;
  const prototype = prototypeOf(ContainerCtor);
  if (!prototype) return new ContainerInterceptor(undefined);
  let interceptor = interceptorRegistry.get(prototype);
  if (!interceptor) {
    interceptor = new ContainerInterceptor(ContainerCtor);
    interceptorRegistry.set(prototype, interceptor);
  }
  return interceptor;
}
