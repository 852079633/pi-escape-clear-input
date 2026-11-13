import {
  CustomEditor,
  createLocalBashOperations,
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type EscapeEditor = {
  onEscape?: () => void;
  getText?: () => string;
  setText?: (text: string) => void;
};
type MarkedFactory = EditorFactory & {
  __piEscapeClearInputFactoryV3?: true;
  __piEscapeClearInputDelegate?: EditorFactory;
};
type LegacyFactory = EditorFactory & {
  __piEscapeClearInputFactoryV2?: true;
  __piEscapeClearInputDelegate?: EditorFactory;
};
type EditorInstallation = { state: State; cleanup: () => void };
type MarkedEditor = EscapeEditor & { __piEscapeClearInputEditorV3?: EditorInstallation | true };
type State = {
  active: boolean;
  activeBashes: number;
  editorCleanups: Set<() => void>;
  installedFactory?: EditorFactory;
  restoreEditor?: () => void;
};

function unwrapFactory(factory: EditorFactory | undefined): EditorFactory | undefined {
  let current = factory as MarkedFactory | LegacyFactory | undefined;
  const visited = new Set<EditorFactory>();
  while (
    current &&
    !visited.has(current) &&
    (current.__piEscapeClearInputFactoryV3 || current.__piEscapeClearInputFactoryV2)
  ) {
    visited.add(current);
    current = current.__piEscapeClearInputDelegate as MarkedFactory | LegacyFactory | undefined;
  }
  return current;
}

function instrumentEditor(editor: EscapeEditor, ctx: ExtensionContext, state: State): void {
  if (typeof editor.getText !== "function" || typeof editor.setText !== "function") return;

  const marked = editor as MarkedEditor;
  const existing = marked.__piEscapeClearInputEditorV3;
  if (existing && typeof existing === "object") {
    if (existing.state === state) return;
    existing.cleanup();
  }

  const originalDescriptor = Object.getOwnPropertyDescriptor(editor, "onEscape");
  // Only instrument a normal, writable CustomEditor field. Leave custom accessors,
  // inherited implementations, and non-configurable editors untouched.
  if (
    !originalDescriptor ||
    !("value" in originalDescriptor) ||
    !originalDescriptor.configurable ||
    originalDescriptor.writable === false ||
    (originalDescriptor.value !== undefined && typeof originalDescriptor.value !== "function")
  ) {
    return;
  }

  let currentHandler = originalDescriptor.value as (() => void) | undefined;
  const originalToWrapper = new WeakMap<() => void, () => void>();
  const wrapperToOriginal = new WeakMap<() => void, () => void>();

  const unwrapHandler = (handler: (() => void) | undefined): (() => void) | undefined => {
    let current = handler;
    const visited = new Set<() => void>();
    while (current && wrapperToOriginal.has(current) && !visited.has(current)) {
      visited.add(current);
      current = wrapperToOriginal.get(current);
    }
    return current;
  };

  const wrapHandler = (handler: (() => void) | undefined): (() => void) | undefined => {
    const original = unwrapHandler(handler);
    if (!original) return undefined;
    const existingWrapper = originalToWrapper.get(original);
    if (existingWrapper) return existingWrapper;

    const wrapped = () => {
      // Shutdown may invalidate this extension context. Do not inspect it after deactivation.
      if (!state.active) {
        original();
        return;
      }

      // Snapshot before native handling: Bash abort may finish synchronously.
      const wasIdle = ctx.isIdle();
      const bashWasRunning = state.activeBashes > 0;
      const textBefore = editor.getText!();

      // Preserve Pi's native priority. Autocomplete and dialogs route Escape elsewhere.
      original();

      // Only clear when the native handler did not act on an idle prompt draft.
      if (
        state.active &&
        wasIdle &&
        !bashWasRunning &&
        textBefore.length > 0 &&
        editor.getText!() === textBefore
      ) {
        editor.setText!("");
      }
    };

    originalToWrapper.set(original, wrapped);
    wrapperToOriginal.set(wrapped, original);
    return wrapped;
  };

  const getter = () => wrapHandler(currentHandler);
  const setter = (next: (() => void) | undefined) => {
    currentHandler = unwrapHandler(next);
  };
  Object.defineProperty(editor, "onEscape", {
    configurable: true,
    enumerable: originalDescriptor.enumerable,
    get: getter,
    set: setter,
  });

  const installation: EditorInstallation = {
    state,
    cleanup: () => {
      const currentDescriptor = Object.getOwnPropertyDescriptor(editor, "onEscape");
      if (currentDescriptor?.get === getter && currentDescriptor?.set === setter) {
        Object.defineProperty(editor, "onEscape", {
          ...originalDescriptor,
          value: currentHandler,
        });
      }
      if (marked.__piEscapeClearInputEditorV3 === installation) {
        delete marked.__piEscapeClearInputEditorV3;
      }
      state.editorCleanups.delete(installation.cleanup);
    },
  };
  Object.defineProperty(marked, "__piEscapeClearInputEditorV3", {
    configurable: true,
    value: installation,
  });
  state.editorCleanups.add(installation.cleanup);
}

function wrapFactory(
  delegate: EditorFactory | undefined,
  ctx: ExtensionContext,
  state: State,
): EditorFactory {
  const wrapped: MarkedFactory = (tui, theme, keybindings) => {
    const editor = delegate?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
    instrumentEditor(editor as EscapeEditor, ctx, state);
    return editor;
  };
  wrapped.__piEscapeClearInputFactoryV3 = true;
  wrapped.__piEscapeClearInputDelegate = delegate;
  return wrapped;
}

export default function (pi: ExtensionAPI): void {
  const state: State = { active: true, activeBashes: 0, editorCleanups: new Set() };

  // This package is installed after the configured Bash observers. Wrap Pi's own
  // local backend only for user-entered ! commands; agent Bash tools remain native.
  pi.on("user_bash", (_event, ctx) => {
    if (!state.active || ctx.mode !== "tui") return;

    // Reuse Pi's effective global/project shell setting rather than changing the backend.
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    const local = createLocalBashOperations({ shellPath: settings.getShellPath() });
    return {
      operations: {
        async exec(command, cwd, options) {
          state.activeBashes++;
          try {
            return await local.exec(command, cwd, options);
          } finally {
            state.activeBashes = Math.max(0, state.activeBashes - 1);
          }
        },
      },
    };
  });

  // resources_discover follows all session_start handlers. The same runner UI object
  // retains Open TUI's proxy, so setting through it composes the delegate in-place.
  pi.on("resources_discover", (_event, ctx) => {
    if (!state.active || ctx.mode !== "tui") return;

    state.restoreEditor?.();
    const ui = ctx.ui;
    const current = ui.getEditorComponent() as MarkedFactory | LegacyFactory | undefined;
    const delegate = unwrapFactory(current);
    const wrapped = wrapFactory(delegate, ctx, state);
    state.installedFactory = wrapped;
    ui.setEditorComponent(wrapped);

    state.restoreEditor = () => {
      if (state.installedFactory !== wrapped) return;
      const currentFactory = ui.getEditorComponent() as EditorFactory | undefined;
      if (currentFactory === wrapped) ui.setEditorComponent(delegate);
      state.installedFactory = undefined;
      state.restoreEditor = undefined;
    };
  });

  pi.on("session_shutdown", () => {
    state.active = false;
    state.restoreEditor?.();
    for (const cleanup of [...state.editorCleanups]) cleanup();
  });
}
