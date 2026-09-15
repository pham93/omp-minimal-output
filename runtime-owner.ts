// Process-global generation ownership for hot-reloaded extension instances.
// The state lives on globalThis so a newly evaluated module can dispose the
// previous generation before registering UI hooks and timers of its own.

const RUNTIME_STATE_KEY = Symbol.for("@local/omp-minimal-output/runtime-owner");

interface RuntimeState {
  owner?: symbol;
  dispose?: () => void;
  generation: number;
}

export interface RuntimeOwner {
  generation: number;
  owns: () => boolean;
  setCleanup: (cleanup: () => void) => void;
  release: () => void;
}

function runtimeState(): RuntimeState {
  const root = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = root[RUNTIME_STATE_KEY];
  if (typeof existing === "object" && existing !== null && "generation" in existing) {
    return existing as unknown as RuntimeState;
  }
  const created: RuntimeState = { generation: 0 };
  root[RUNTIME_STATE_KEY] = created;
  return created;
}

export function acquireRuntimeOwner(): RuntimeOwner {
  const state = runtimeState();
  const previousDispose = state.dispose;
  state.dispose = undefined;
  try {
    previousDispose?.();
  } catch {
    // A stale generation must never prevent the replacement from loading.
  }

  const token = Symbol("omp-minimal-output-generation");
  state.owner = token;
  state.generation += 1;
  const generation = state.generation;
  let cleanup: (() => void) | undefined;

  const owns = (): boolean => state.owner === token;
  const runCleanup = (): void => {
    const current = cleanup;
    cleanup = undefined;
    try {
      current?.();
    } catch {
      // Cleanup is defensive; ownership transfer must always complete.
    }
  };

  return {
    generation,
    owns,
    setCleanup(nextCleanup: () => void): void {
      cleanup = nextCleanup;
      if (!owns()) {
        runCleanup();
        return;
      }
      state.dispose = () => {
        if (!owns()) return;
        runCleanup();
      };
    },
    release(): void {
      if (!owns()) return;
      state.dispose = undefined;
      runCleanup();
      if (state.owner === token) state.owner = undefined;
    },
  };
}
