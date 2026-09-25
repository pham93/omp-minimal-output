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

/**
 * Drop `undefined`/`null` children before they reach the host. The composer's
 * frame layout walks every entry of its chrome list and dereferences it
 * (`Composer.renderFrame` → `rowTargetCandidates`), so one non-component takes
 * the whole render loop down with `TypeError: undefined is not an object`.
 * Components pass through untouched, and a clean list is returned as-is (same
 * array reference), so callers can detect whether anything was dropped.
 */
export function definedChildren(children: readonly unknown[]): readonly unknown[] {
  if (!Array.isArray(children)) return [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child !== undefined && child !== null) continue;
    const kept: unknown[] = [];
    for (const candidate of children) {
      if (candidate !== undefined && candidate !== null) kept.push(candidate);
    }
    return kept;
  }
  return children;
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
              if (result && Array.isArray(result.children)) children = result.children;
            } catch {
              // Skin failures must not change native insertion or error semantics.
            }
          }
          const kept = definedChildren(children);
          // `Container.addChild` pushes its argument unconditionally: calling it with no child stores
          // a literal `undefined` in the child list, and the composer's frame loop dereferences every
          // chrome child (`Composer.renderFrame` → `rowTargetCandidates`), so one dropped row would
          // take the render loop down with `TypeError: undefined is not an object`. Dropping a child
          // means inserting nothing at all.
          if (kept.length === 0) return undefined;
          return native.apply(this, kept as unknown[]);
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
