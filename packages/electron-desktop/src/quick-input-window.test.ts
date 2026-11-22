import { describe, expect, mock, test } from "bun:test";

type Listener = (...args: unknown[]) => unknown;

const handleListeners = new Map<string, Listener>();

mock.module("./ipc", () => ({
  handle: (channel: string, _schema: unknown, fn: Listener) => {
    handleListeners.set(channel, fn);
  },
  handleSync: () => undefined,
  on: () => undefined,
}));

const dispatches: unknown[] = [];
let ensuredVisible = 0;

const {
  installQuickInput,
  configureQuickInputWindow,
  // Imported for the type shape only — the submit handler's contract.
} = await import("./quick-input-window");

const configure = () => {
  configureQuickInputWindow({
    createWindow: () => {
      throw new Error("not expected in this test");
    },
    dispatchToMain: (command: unknown) => dispatches.push(command),
    ensureMainWindowVisible: () => {
      ensuredVisible += 1;
    },
    resolveRoute: (route: string) => `http://localhost:5173${route}`,
  });
};

// The module's `installed` flag persists across tests, so the channel
// registrations made by the first install stay in `handleListeners` for
// the later ones — clear only the per-invocation recorders.
describe("installQuickInput", () => {
  test("registers its channels without prior configuration", () => {
    // The regression: install used to read the configuration eagerly and
    // threw when the lifecycle installed the channels before the
    // composition's `installAuxiliaryWindows` configured the module.
    installQuickInput();
    expect(handleListeners.size).toBe(2);
  });

  test("a second install is a no-op", () => {
    installQuickInput();
    installQuickInput();
    expect(handleListeners.size).toBe(2);
  });

  test("the submit handler dispatches once configured", async () => {
    configure();

    await handleListeners.get("cadet:quickInput:submit")!(["hello world"]);

    expect(ensuredVisible).toBe(1);
    expect(dispatches).toEqual([
      { kind: "quickInputSubmit", message: "hello world" },
    ]);
  });
});
