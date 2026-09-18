import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export interface CommandDelegates {
  minimalOn: (ctx: ExtensionContext) => Promise<void> | void;
  minimalOff: (ctx: ExtensionContext) => Promise<void> | void;
  todosShow: (ctx: ExtensionContext) => Promise<void> | void;
  todos: (ctx: ExtensionContext) => Promise<void> | void;
  demoWrite: (ctx: ExtensionContext) => Promise<void> | void;
  demo: (args: string | undefined, ctx: ExtensionContext) => Promise<void> | void;
  minimalStatus: (ctx: ExtensionContext) => Promise<void> | void;
  toggleTodosShortcut: (ctx: ExtensionContext) => Promise<void> | void;
}

export interface PluginCommandHandle {
  setDelegates: (delegates: CommandDelegates) => void;
  getDelegates: () => CommandDelegates | undefined;
}

export function registerPluginCommands(
  pi: ExtensionAPI,
  ensureActivated: (ctx: ExtensionContext) => Promise<void>,
): PluginCommandHandle {
  let commandDelegates: CommandDelegates | undefined;

  pi.registerCommand("minimal-on", {
    description: "Enable grok-build-style minimal output",
    handler: async (_args, ctx) => {
      await ensureActivated(ctx);
      await commandDelegates?.minimalOn(ctx);
    },
  });

  pi.registerCommand("minimal-off", {
    description: "Disable grok-build-style minimal output",
    handler: async (_args, ctx) => {
      await ensureActivated(ctx);
      await commandDelegates?.minimalOff(ctx);
    },
  });

  pi.registerCommand("todos-show", {
    description: "Show the current session todo card",
    handler: async (_args, ctx) => {
      await ensureActivated(ctx);
      await commandDelegates?.todosShow(ctx);
    },
  });

  pi.registerCommand("todos", {
    description: "Toggle todos widget expand/collapse",
    handler: async (_args, ctx) => {
      await ensureActivated(ctx);
      await commandDelegates?.todos(ctx);
    },
  });

  pi.registerCommand("demo-write", {
    description: "Live interactive demonstration of Write card streaming",
    handler: async (_args, ctx) => {
      await ensureActivated(ctx);
      await commandDelegates?.demoWrite(ctx);
    },
  });
  pi.registerCommand("demo", {
    description: "Interactive demonstration of minimal output cards (e.g. /demo, /demo edit, /demo eval, /demo grouped)",
    handler: async (args, ctx) => {
      await ensureActivated(ctx);
      await commandDelegates?.demo(args, ctx);
    },
  });

  pi.registerCommand("demo-all", {
    description: "Interactive demonstration tour of all minimal output cards and surfaces",
    handler: async (_args, ctx) => {
      await ensureActivated(ctx);
      await commandDelegates?.demo("all", ctx);
    },
  });

  pi.registerCommand("minimal-status", {
    description: "Show minimal-output plugin state",
    handler: async (_args, ctx) => {
      await ensureActivated(ctx);
      await commandDelegates?.minimalStatus(ctx);
    },
  });

  pi.registerShortcut("ctrl+alt+t", {
    description: "Toggle todos widget expand/collapse",
    handler: async (ctx) => {
      await ensureActivated(ctx);
      await commandDelegates?.toggleTodosShortcut(ctx);
    },
  });

  return {
    setDelegates: (delegates: CommandDelegates) => {
      commandDelegates = delegates;
    },
    getDelegates: () => commandDelegates,
  };
}
