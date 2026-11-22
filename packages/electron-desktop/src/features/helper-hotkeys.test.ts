import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

import { electronMock } from "../../test-setup";
import { FakeChild } from "../test-helpers";
class FakeHotkeyChild extends FakeChild {
  stdin = {
    writes: new Array<string>(),
    ended: false,
    write: mock((data: string, callback?: (err?: Error) => void) => {
      this.stdin.writes.push(data);
      callback?.();
      return true;
    }),
    end: mock(() => {
      this.stdin.ended = true;
    }),
  };
  kill = mock(() => true);
}

/** Where the test client's helper executable pretends to live. The real
 * shells resolve their own paths; the feature under test never sees one. */
const HELPER_PATH = "/fake/helpers/cadet-helper";

const appListeners = new Map<string, () => void>();
const handlers: Record<string, (args: unknown[], event: unknown) => unknown> =
  {};

mock.module("electron", () =>
  electronMock({
    app: {
      getVersion: () => "0.0.0",
      getName: () => "Cadet",
      isPackaged: false,
      getAppPath: () => "/repo/clients/macos",
      on: (event: string, listener: () => void) => {
        appListeners.set(event, listener);
      },
    },
    BrowserWindow: {
      fromWebContents: (webContents: FakeWebContents) =>
        webContents.ownerWindow,
      getAllWindows: () => [],
    },
    ipcMain: {
      handle: mock(() => undefined),
      on: mock(() => undefined),
      removeAllListeners: mock(() => undefined),
    },
  }),
);

let exists = true;
let lastChild: FakeHotkeyChild | null = null;
const spawnCalls: Array<[string, string[], object]> = [];
/** When on, every selection.read frame answers itself on the same child (see
 * the warmup-retry bound test). */
let autoAnswerSelectionRead = false;
let seenRequests: unknown[] = [];
mock.module("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts: object) => {
    spawnCalls.push([cmd, args, opts]);
    const child = new FakeHotkeyChild();
    const { write } = child.stdin;
    child.stdin.write = mock((data: string, callback?: () => void) => {
      const result = write(data, callback);
      if (autoAnswerSelectionRead) {
        const request = JSON.parse(String(data));
        if (request.method === "selection.read") {
          seenRequests.push(request.params);
          child.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result: { unavailable: true, holdId: 7 },
              }) + "\n",
            ),
          );
        }
      }
      return result;
    });
    lastChild = child;
    return child;
  },
}));

mock.module("node:fs", () => ({
  existsSync: () => exists,
  readdirSync: () => {
    throw new Error("directory walks are not exercised here");
  },
  readFileSync: () => {
    throw new Error("plist reads are not exercised here");
  },
}));

mock.module("../app-logger", () => ({
  getLogFilePaths: () => [],
  default: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

mock.module("../ipc", () => ({
  handle: (
    channel: string,
    _schema: unknown,
    fn: (args: unknown[], event: unknown) => unknown,
  ) => {
    handlers[channel] = fn;
  },
  on: (
    channel: string,
    _schema: unknown,
    fn: (args: unknown[], event: unknown) => unknown,
  ) => {
    handlers[channel] = fn;
  },
}));

class FakeWebContents extends EventEmitter {
  id = 0;
  isDestroyed = (): boolean => false;
  ownerWindow: EventEmitter = new EventEmitter();
  send: ReturnType<typeof mock> = mock(() => undefined);
}

let nextWebContentsId = 1;

const makeWebContents = (): FakeWebContents => {
  const webContents = new FakeWebContents();
  webContents.id = nextWebContentsId++;
  return webContents;
};

let defaultSender = makeWebContents();

const { default: log } = await import("../app-logger");
const { NativeSidecarClient } =
  await import("@mycadet/native-sidecar/supervisor");

let sharedClient: InstanceType<typeof NativeSidecarClient> | null = null;
let supervisorOptions: Record<string, unknown> = {};
mock.module("../native-helper-client", () => ({
  getSharedHelperClient: () =>
    (sharedClient ??= new NativeSidecarClient({
      resolveExecutablePath: () => HELPER_PATH,
      logger: log,
      ...supervisorOptions,
    })),
  resetSharedHelperClient: () => {
    sharedClient = null;
  },
}));

const { resetSharedHelperClient } = await import("../native-helper-client");

const { install: installDictationHelper, __resetForTesting: resetDictation } =
  await import("./dictation");

const {
  install: installHelperHotkeys,
  __resetForTesting,
  postFrontAppShortcut,
} = await import("./helper-hotkeys");

const {
  __resetFrameScrollWatchForTesting,
  watchFrameScroll,
  unwatchFrameScroll,
} = await import("./frame-scroll-watch");

const {
  __resetCoachmarkPressWatchForTesting,
  watchCoachmarkPress,
  unwatchCoachmarkPress,
} = await import("./coachmark-press-watch");

const { setPointerOnCompanion } = await import("./companion-pointer");

/**
 * The composition the mac shell runs: the shared helper client supervises
 * the sidecar, and the hotkey half installs beside dictation, taking the
 * shell's watch state and companion check.
 */
const installHelperBridge = (): void => {
  installDictationHelper();
  installHelperHotkeys();
};

const CTRL_OPTION = { kind: "modifierOnly", modifiers: ["control", "option"] };

/** The recorded handle callback for `channel`, fired the way the shared ipc
 * registrar delivers: the parsed argument tuple, then the event. */
const invoke = (
  channel: string,
  args: unknown[] = [],
  sender: FakeWebContents = defaultSender,
): unknown => handlers[channel]!(args, { sender });

const invokeSetModifierHoldFrom = (hold: unknown, sender: FakeWebContents) =>
  invoke("cadet:helper:hotkey:setModifierHold", [hold], sender);

const invokeSetModifierHold = (hold: unknown = CTRL_OPTION) =>
  invokeSetModifierHoldFrom(hold, defaultSender);

/**
 * Register the hold and answer the helper's reply. Registrations are chained,
 * so the request reaches the helper a tick after the call.
 */
const registerHold = async (
  sender: FakeWebContents = defaultSender,
  id?: number,
): Promise<unknown> => {
  const before = writesSeen();
  const pending = invokeSetModifierHoldFrom(CTRL_OPTION, sender);
  await until(() => writesSeen() > before, "the hold request to be written");
  const request = lastChild?.stdin.writes.at(-1) ?? "";
  const parsed: { id?: number } = JSON.parse(request);
  const answered = id ?? parsed.id;
  lastChild?.stdout.emit(
    "data",
    Buffer.from(
      `{"jsonrpc":"2.0","id":${answered},"result":{"enabled":true}}\n`,
    ),
  );
  return pending;
};

const OPTION_CHORDS = {
  kind: "chord",
  modifiers: ["option"],
  keys: ["s", "d"],
};

const invokeSetChords = (binding: unknown, sender: FakeWebContents) =>
  invoke("cadet:helper:hotkey:setChords", [binding], sender);

/**
 * Arm the chords from `sender` and answer the helper's reply.
 *
 * The id is read back off the request rather than assumed: the fake child
 * outlives a test, so which id a call gets depends on what ran before it.
 */
const registerChords = async (sender: FakeWebContents): Promise<unknown> => {
  const before = writesSeen();
  const pending = invokeSetChords(OPTION_CHORDS, sender);
  await until(() => writesSeen() > before, "the chords request to be written");
  const request = lastChild?.stdin.writes.at(-1) ?? "";
  const parsed: { id?: number } = JSON.parse(request);
  const id = parsed.id;
  lastChild?.stdout.emit(
    "data",
    Buffer.from(`{"jsonrpc":"2.0","id":${id},"result":{"enabled":true}}\n`),
  );
  return pending;
};

const emitChord = (key: string): void => {
  lastChild?.stdout.emit(
    "data",
    Buffer.from(
      `{"jsonrpc":"2.0","method":"hotkey.event","params":{"kind":"chord","state":"down","key":"${key}"}}\n`,
    ),
  );
};

const invokeReadFrontSelection = () =>
  invoke("cadet:helper:hotkey:readFrontSelection");

const invokePing = () => invoke("cadet:helper:ping");

const invokeGetState = () => invoke("cadet:helper:state:get");

const invokeRestart = () => invoke("cadet:helper:restart");

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Several loop turns: the fixed sleeps here are settle windows, and a
 * single 5ms hop loses to the client's lazy spawn once cores saturate. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 5));
};

/** Waits for a condition with a deadline — fixed sleeps race the client's
 * lazy spawn once the cores are saturated. */
const until = async (
  predicate: () => boolean,
  label: string,
): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await settle();
  }
};

const writesSeen = (): number => lastChild?.stdin.writes.length ?? 0;

beforeEach(() => {
  __resetForTesting();
  resetDictation();
  for (const key of Object.keys(handlers)) delete handlers[key];
  appListeners.clear();
  spawnCalls.length = 0;
  lastChild = null;
  exists = true;
  supervisorOptions = {};
  nextWebContentsId = 1;
  defaultSender = makeWebContents();
  __resetFrameScrollWatchForTesting();
  __resetCoachmarkPressWatchForTesting();
  setPointerOnCompanion(false);
});

afterEach(() => {
  __resetForTesting();
  resetDictation();
  resetSharedHelperClient();
});

describe("installHotkeyHelper", () => {
  test("registers the helper IPC handlers", () => {
    installHelperBridge();
    expect(handlers["cadet:helper:ping"]).toBeDefined();
    expect(handlers["cadet:helper:state:get"]).toBeDefined();
    expect(handlers["cadet:helper:restart"]).toBeDefined();
    expect(handlers["cadet:helper:hotkey:setModifierHold"]).toBeDefined();
    expect(handlers["cadet:helper:hotkey:readFrontSelection"]).toBeDefined();
  });

  test("pings the helper process", async () => {
    installHelperBridge();
    const pending = invokePing();

    expect(lastChild?.stdin.writes[0]).toContain('"jsonrpc":"2.0"');
    expect(lastChild?.stdin.writes[0]).toContain('"method":"ping"');

    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":"pong"}\n'),
    );

    expect(await pending).toBe("pong");
  });

  test("exposes helper state and user-initiated restart", () => {
    installHelperBridge();

    expect(invokeGetState()).toEqual({ status: "idle" });

    expect(invokeRestart()).toEqual({
      ok: true,
      state: { status: "running" },
    });
    expect(spawnCalls[0]?.[0]).toBe(HELPER_PATH);
  });

  test("sends hotkey.modifierHold to the helper process", async () => {
    installHelperBridge();
    const pending = invokeSetModifierHold();
    await settle();

    expect(spawnCalls[0]?.[0]).toBe(HELPER_PATH);
    expect(lastChild?.stdin.writes[0]).toContain('"jsonrpc":"2.0"');
    expect(lastChild?.stdin.writes[0]).toContain(
      '"method":"hotkey.modifierHold"',
    );
    expect(lastChild?.stdin.writes[0]).toContain('"enable":true');
    expect(lastChild?.stdin.writes[0]).toContain(
      '"modifiers":["control","option"]',
    );

    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"enabled":true}}\n'),
    );

    expect(await pending).toEqual({ ok: true, enabled: true });
  });

  /**
   * The renderer registered once and is not told about the restart, so the
   * key would be dead until the next reload if main did not hand the new
   * helper the binding.
   */
  test("restores the hold after a helper crash", async () => {
    supervisorOptions = { initialBackoffMs: 1, maxBackoffMs: 1 };
    installHelperBridge();
    expect(await registerHold()).toEqual({ ok: true, enabled: true });

    const crashed = lastChild;
    crashed?.emit("close", 1, null);
    await settle();

    expect(spawnCalls).toHaveLength(2);
    expect(lastChild).not.toBe(crashed);
    expect(lastChild?.stdin.writes[0]).toContain(
      '"method":"hotkey.modifierHold"',
    );
    expect(lastChild?.stdin.writes[0]).toContain('"enable":true');
    expect(lastChild?.stdin.writes[0]).toContain(
      '"modifiers":["control","option"]',
    );
  });

  test("maps JSON-RPC helper errors to hotkey results", async () => {
    installHelperBridge();
    const pending = invokeSetModifierHold();
    await settle();

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"Carbon failed"}}\n',
      ),
    );

    expect(await pending).toEqual({ ok: false, reason: "Carbon failed" });
  });

  test("returns unavailable when the helper executable is missing", async () => {
    exists = false;
    installHelperBridge();

    expect(await invokeSetModifierHold()).toEqual({
      ok: false,
      reason: "native-sidecar-client is not available",
    });
  });

  test("routes hotkey-event envelopes to the registered owner", async () => {
    installHelperBridge();
    expect(await registerHold()).toEqual({ ok: true, enabled: true });

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"hotkey.event","params":{"kind":"modifierHold","state":"down"}}\n',
      ),
    );

    expect(defaultSender.send).toHaveBeenCalledWith(
      "cadet:helper:hotkey:event",
      { kind: "modifierHold", state: "down" },
    );
  });

  /**
   * A chord binding is a different question from the hold's, and travels as
   * its own registration: the modifiers that must be held, and the keys that
   * mean something under them.
   */
  test("sends hotkey.chords to the helper process", async () => {
    installHelperBridge();
    expect(await registerChords(makeWebContents())).toEqual({
      ok: true,
      enabled: true,
    });

    const sent = lastChild?.stdin.writes.join("") ?? "";
    expect(sent).toContain('"method":"hotkey.chords"');
    expect(sent).toContain('"enable":true');
    expect(sent).toContain('"modifiers":["option"]');
    expect(sent).toContain('"keys":["s","d"]');
  });

  /**
   * The window that armed them, whatever is focused. A hold's edges follow
   * focus because a hold is a microphone the user pointed somewhere; a chord
   * asks something of the session, which lives in one window, so a pop-out in
   * front must not take a press meant for the call.
   */
  test("a chord goes to the window that armed it, not the focused one", async () => {
    installHelperBridge();
    const owner = makeWebContents();
    const focused = makeWebContents();
    expect(await registerChords(owner)).toEqual({ ok: true, enabled: true });
    // The other window takes the hold's ownership, which does follow focus.
    expect(await registerHold(focused)).toEqual({ ok: true, enabled: true });

    emitChord("s");

    const chord = { kind: "chord", state: "down", key: "s" };
    expect(owner.send).toHaveBeenCalledWith("cadet:helper:hotkey:event", chord);
    expect(focused.send).not.toHaveBeenCalledWith(
      "cadet:helper:hotkey:event",
      chord,
    );
  });

  /**
   * A binding armed with nothing left to answer it is the helper going on
   * taking presses that are the user's own again.
   */
  test("clears the chords when the window that armed them goes", async () => {
    installHelperBridge();
    const owner = makeWebContents();
    expect(await registerChords(owner)).toEqual({ ok: true, enabled: true });
    const before = lastChild?.stdin.writes.length ?? 0;

    owner.emit("destroyed");
    await settle();

    const sent = lastChild?.stdin.writes.slice(before).join("") ?? "";
    expect(sent).toContain('"method":"hotkey.chords"');
    expect(sent).toContain('"enable":false');
  });

  /**
   * And a chord that arrives anyway is dropped rather than handed to whoever
   * is focused: the press asked something of a session that has gone.
   */
  test("drops a chord once the window that armed it has gone", async () => {
    installHelperBridge();
    const owner = makeWebContents();
    const other = makeWebContents();
    expect(await registerChords(owner)).toEqual({ ok: true, enabled: true });
    expect(await registerHold(other)).toEqual({ ok: true, enabled: true });
    owner.emit("destroyed");
    await settle();
    other.send.mockClear();

    emitChord("s");

    expect(other.send).not.toHaveBeenCalled();
  });

  test("carries the reason a hold closed through to the owner", async () => {
    installHelperBridge();
    expect(await registerHold()).toEqual({ ok: true, enabled: true });

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"hotkey.event","params":{"kind":"modifierHold","state":"up","reason":"chord"}}\n',
      ),
    );

    expect(defaultSender.send).toHaveBeenCalledWith(
      "cadet:helper:hotkey:event",
      { kind: "modifierHold", state: "up", reason: "chord" },
    );
  });

  /**
   * Whether the paste may be sent again another way turns on this answer: a
   * helper that says it sent nothing can be retried, and one whose reply was
   * lost cannot, since the keystroke may have gone before the reply did.
   */
  describe("front app shortcut", () => {
    const reply = (json: string) => {
      lastChild?.stdout.emit("data", Buffer.from(`${json}\n`));
    };

    test("reports a posted shortcut", async () => {
      installHelperBridge();
      const pending = postFrontAppShortcut("v");
      reply('{"jsonrpc":"2.0","id":1,"result":{"outcome":"posted"}}');

      expect(lastChild?.stdin.writes[0]).toContain('"method":"keys.shortcut"');
      expect(lastChild?.stdin.writes[0]).toContain('"key":"v"');
      expect(await pending).toBe("posted");
    });

    test("reads a helper without Accessibility as declined", async () => {
      installHelperBridge();
      const pending = postFrontAppShortcut("v");
      reply('{"jsonrpc":"2.0","id":1,"result":{"outcome":"untrusted"}}');

      expect(await pending).toBe("declined");
    });

    test("reads a helper that does not know the method as declined", async () => {
      installHelperBridge();
      const pending = postFrontAppShortcut("v");
      reply(
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}',
      );

      expect(await pending).toBe("declined");
    });

    test("reads a helper that exits before replying as unknown", async () => {
      installHelperBridge();
      const pending = postFrontAppShortcut("v");
      lastChild?.emit("close", 1, null);

      expect(await pending).toBe("unknown");
    });
  });

  test("reads what is highlighted in the application in front", async () => {
    installHelperBridge();

    const pending = invokeReadFrontSelection();
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"result":{"selection":{"text":"the powerhouse","truncated":false,"editable":true}}}\n',
      ),
    );

    expect(lastChild?.stdin.writes[0]).toContain('"method":"selection.read"');
    expect(await pending).toEqual({
      text: "the powerhouse",
      truncated: false,
      editable: true,
    });
  });

  test("reads a selection that says nothing about editability as read-only", async () => {
    installHelperBridge();

    const pending = invokeReadFrontSelection();
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"result":{"selection":{"text":"the powerhouse","truncated":false}}}\n',
      ),
    );

    expect(await pending).toEqual({
      text: "the powerhouse",
      truncated: false,
      editable: false,
    });
  });

  test("reads nothing highlighted as no selection", async () => {
    installHelperBridge();

    const pending = invokeReadFrontSelection();
    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'),
    );

    expect(await pending).toBeNull();
  });

  test("keeps a refused selection distinct from no selection", async () => {
    installHelperBridge();

    const pending = invokeReadFrontSelection();
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"no front app"}}\n',
      ),
    );

    expect(await pending).toEqual({ unavailable: true });
  });

  test("retries accessibility warmup with the original hold id", async () => {
    installHelperBridge();
    const pending = invokeReadFrontSelection();
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"result":{"unavailable":true,"holdId":7}}\n',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(JSON.parse(lastChild!.stdin.writes[1]!)).toMatchObject({
      method: "selection.read",
      params: { holdId: 7 },
    });
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":2,"result":{"selection":{"text":"Example passage","truncated":false,"editable":true}}}\n',
      ),
    );
    expect(await pending).toEqual({
      text: "Example passage",
      truncated: false,
      editable: true,
    });
  });

  test("stops retrying when the hold or foreground app changes", async () => {
    installHelperBridge();
    const pending = invokeReadFrontSelection();
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"result":{"unavailable":true,"holdId":7}}\n',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 130));
    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"unavailable":true}}\n'),
    );
    expect(await pending).toEqual({ unavailable: true });
    expect(lastChild?.stdin.writes).toHaveLength(2);
  });

  test("does not retry a non-retryable capture failure", async () => {
    installHelperBridge();
    const pending = invokeReadFrontSelection();
    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"unavailable":true}}\n'),
    );
    expect(await pending).toEqual({ unavailable: true });
    expect(lastChild?.stdin.writes).toHaveLength(1);
  });

  test("bounds warmup retries beyond Chromium's two-second debounce", async () => {
    installHelperBridge();
    seenRequests = [];
    autoAnswerSelectionRead = true;
    try {
      expect(await invokeReadFrontSelection()).toEqual({ unavailable: true });
    } finally {
      autoAnswerSelectionRead = false;
    }
    expect(seenRequests).toHaveLength(31);
    expect(seenRequests[0]).toBeUndefined();
    expect(seenRequests.at(1)).toEqual({ holdId: 7 });
    expect(seenRequests.at(30)).toEqual({ holdId: 7 });
  });

  test("does not treat malformed selection data as no selection", async () => {
    installHelperBridge();
    const pending = invokeReadFrontSelection();
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"result":{"selection":{"text":42}}}\n',
      ),
    );
    expect(await pending).toEqual({ unavailable: true });
  });

  test("asks the helper which of the named apps are running", async () => {
    installHelperBridge();

    const pending = invoke("cadet:helper:apps:running", [
      ["com.electron.wispr-flow", "com.example.other"],
    ]);
    expect(lastChild?.stdin.writes[0]).toContain('"method":"apps.running"');
    expect(lastChild?.stdin.writes[0]).toContain('"com.electron.wispr-flow"');
    // Only the claimant is asked about; the renderer does not enumerate the
    // desktop through this.
    expect(lastChild?.stdin.writes[0]).not.toContain('"com.example.other"');
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"result":{"running":["com.electron.wispr-flow"]}}\n',
      ),
    );

    expect(await pending).toEqual(["com.electron.wispr-flow"]);
  });

  test("reads a helper that cannot say as no apps running", async () => {
    installHelperBridge();

    const pending = invoke("cadet:helper:apps:running", [
      ["com.electron.wispr-flow"],
    ]);
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"no workspace"}}\n',
      ),
    );

    expect(await pending).toEqual([]);
  });

  test("asks nothing of the helper for an app outside the voice key's claimants", async () => {
    installHelperBridge();

    expect(await invoke("cadet:helper:apps:quit", ["com.example.editor"])).toBe(
      false,
    );
    expect(lastChild).toBeNull();
    expect(
      await invoke("cadet:helper:apps:running", [["com.example.editor"]]),
    ).toEqual([]);
    expect(lastChild).toBeNull();
  });

  test("reads the application in front from the helper", async () => {
    installHelperBridge();

    const pending = invoke("cadet:helper:apps:frontmost");
    expect(lastChild?.stdin.writes[0]).toContain('"method":"apps.frontmost"');
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"result":{"bundleId":"com.example.editor"}}\n',
      ),
    );

    expect(await pending).toBe("com.example.editor");
  });

  /**
   * A press on the companion's own controls is not an edit in the user's
   * document, and the offer those controls answer must survive being pressed.
   */
  test("keeps a press on the companion out of the input activity it forwards", async () => {
    installHelperBridge();
    expect(await registerHold()).toEqual({ ok: true, enabled: true });
    setPointerOnCompanion(true);

    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","method":"input.activity"}\n'),
    );
    expect(defaultSender.send).not.toHaveBeenCalledWith(
      "cadet:helper:input:activity",
    );

    setPointerOnCompanion(false);
    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","method":"input.activity"}\n'),
    );
    expect(defaultSender.send).toHaveBeenCalledWith(
      "cadet:helper:input:activity",
    );
  });

  /**
   * The watch goes down with the helper the binding did, and the renderer
   * asks for neither again.
   */
  test("restores the input watch after a helper crash", async () => {
    supervisorOptions = { initialBackoffMs: 1, maxBackoffMs: 1 };
    installHelperBridge();
    expect(await registerHold()).toEqual({ ok: true, enabled: true });

    const watch = invoke("cadet:helper:input:setActivityWatch", [true]);
    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"enabled":true}}\n'),
    );
    expect(await watch).toBe(true);

    lastChild?.emit("close", 1, null);
    await settle();

    const writes = lastChild?.stdin.writes.join("") ?? "";
    expect(writes).toContain('"method":"input.setActivityWatch"');
    expect(writes).toContain('"enable":true');
  });

  /**
   * The watch frame asks for the scroll watch through its own state, rather
   * than through the renderer: it is main's own window, and the end of the
   * scroll is main's to act on.
   */
  test("asks the helper to watch for the scroll ending and reports it", async () => {
    supervisorOptions = { initialBackoffMs: 1, maxBackoffMs: 1 };
    installHelperBridge();
    expect(await registerHold()).toEqual({ ok: true, enabled: true });

    let ended = 0;
    watchFrameScroll(() => {
      ended += 1;
    });
    await settle();
    let writes = lastChild?.stdin.writes.join("") ?? "";
    expect(writes).toContain('"method":"input.setScrollWatch"');
    expect(writes).toContain('"enable":true');

    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","method":"input.scrollEnded"}\n'),
    );
    expect(ended).toBe(1);

    // The watch goes down with the helper and comes back with it.
    lastChild?.emit("close", 1, null);
    await settle();
    writes = lastChild?.stdin.writes.join("") ?? "";
    expect(writes).toContain('"method":"input.setScrollWatch"');

    unwatchFrameScroll();
    await settle();
    writes = lastChild?.stdin.writes.join("") ?? "";
    expect(writes).toContain('"enable":false');
  });

  /**
   * The marks ask for the press watch through their own state, the way the
   * frame asks for the scroll watch: they are main's, and the press is
   * main's to act on.
   */
  test("asks the helper to watch for a press on a pointed-at control and reports it", async () => {
    supervisorOptions = { initialBackoffMs: 1, maxBackoffMs: 1 };
    installHelperBridge();
    expect(await registerHold()).toEqual({ ok: true, enabled: true });

    const pressed: number[] = [];
    const rect = { x: 120, y: 80, width: 60, height: 20 };
    watchCoachmarkPress([rect], (index) => {
      pressed.push(index);
    });
    await settle();
    let writes = lastChild?.stdin.writes.join("") ?? "";
    expect(writes).toContain('"method":"input.setPressWatch"');
    expect(writes).toContain(JSON.stringify({ rects: [rect] }));

    // The watch goes down with the helper and comes back with it, still on
    // the same rectangles.
    lastChild?.emit("close", 1, null);
    await settle();
    writes = lastChild?.stdin.writes.join("") ?? "";
    expect(writes).toContain('"method":"input.setPressWatch"');

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"input.pressed","params":{"index":0}}\n',
      ),
    );
    expect(pressed).toEqual([0]);

    // A press is one-shot on both sides: a second report is nobody's.
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"input.pressed","params":{"index":0}}\n',
      ),
    );
    expect(pressed).toEqual([0]);

    watchCoachmarkPress([rect], () => {});
    unwatchCoachmarkPress();
    await settle();
    writes = lastChild?.stdin.writes.join("") ?? "";
    expect(writes).toContain('"rects":[]');
  });

  test("forwards input activity to the window that holds the key", async () => {
    installHelperBridge();
    expect(await registerHold()).toEqual({ ok: true, enabled: true });

    const pending = invoke("cadet:helper:input:setActivityWatch", [true]);
    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"enabled":true}}\n'),
    );
    expect(await pending).toBe(true);

    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","method":"input.activity"}\n'),
    );
    expect(defaultSender.send).toHaveBeenCalledWith(
      "cadet:helper:input:activity",
    );
  });

  test("asks the helper to quit an app and reports whether it was asked", async () => {
    installHelperBridge();

    const pending = invoke("cadet:helper:apps:quit", [
      "com.electron.wispr-flow",
    ]);
    expect(lastChild?.stdin.writes[0]).toContain('"method":"apps.quit"');
    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"asked":true}}\n'),
    );

    expect(await pending).toBe(true);
  });

  /**
   * The hold's consumer is a microphone that closes on the `up` of the binding
   * that opened it, so the edge a dead helper owes has to be that binding's,
   * and has to say the user did not let go.
   */
  test("closes a hold the helper died holding with a cancelled edge", async () => {
    supervisorOptions = { initialBackoffMs: 1, maxBackoffMs: 1 };
    installHelperBridge();
    expect(await registerHold()).toEqual({ ok: true, enabled: true });

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"hotkey.event","params":{"kind":"modifierHold","state":"down"}}\n',
      ),
    );
    lastChild?.emit("close", 1, null);
    await settle();

    expect(defaultSender.send).toHaveBeenLastCalledWith(
      "cadet:helper:hotkey:event",
      { kind: "modifierHold", state: "up", reason: "cancelled" },
    );
  });

  test("the edges reach the window that registered last, and never a stranger", async () => {
    installHelperBridge();
    const first = makeWebContents();
    const second = makeWebContents();

    expect(await registerHold(first)).toEqual({ ok: true, enabled: true });
    expect(await registerHold(second, 2)).toEqual({ ok: true, enabled: true });

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"hotkey.event","params":{"kind":"modifierHold","state":"down"}}\n',
      ),
    );
    expect(second.send).toHaveBeenCalledWith("cadet:helper:hotkey:event", {
      kind: "modifierHold",
      state: "down",
    });
    expect(first.send).not.toHaveBeenCalled();
    expect(defaultSender.send).not.toHaveBeenCalled();
  });

  /**
   * A window going away takes its ownership with it, and the binding comes
   * down only with the last of them: a hold armed in the helper with no
   * window left would open a microphone into nothing.
   */
  test("clears the hold when the last owner goes away, not before", async () => {
    installHelperBridge();
    const first = makeWebContents();
    const second = makeWebContents();

    expect(await registerHold(first)).toEqual({ ok: true, enabled: true });
    expect(await registerHold(second, 2)).toEqual({ ok: true, enabled: true });
    const writesBefore = lastChild?.stdin.writes.length;

    first.emit("destroyed");
    await settle();
    expect(lastChild?.stdin.writes.length).toBe(writesBefore);

    second.emit("destroyed");
    await settle();
    expect(lastChild?.stdin.writes.at(-1)).toContain(
      '"method":"hotkey.modifierHold"',
    );
    expect(lastChild?.stdin.writes.at(-1)).toContain('"enable":false');
  });
});
