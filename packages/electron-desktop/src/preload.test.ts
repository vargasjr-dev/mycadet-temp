import { beforeEach, expect, mock, test } from "bun:test";

import { electronMock } from "../test-setup";

// The preload module graph runtime-imports the electron module (the
// features pull `ipcRenderer` themselves), so it must be mocked before
// the factories load. The factories under test read the mocked
// `ipcRenderer` exactly the way the packaged preload does.
type Listener = (...args: unknown[]) => void;
const listeners = new Map<string, Listener>();
const invoke = mock((channel: string, ..._args: unknown[]) =>
  Promise.resolve(
    channel === NOTIFICATIONS_REGISTER_IDENTITY_PUBLISHER
      ? true
      : { success: true },
  ),
);
const send = mock((_channel: string, ..._args: unknown[]) => undefined);
const off = mock((_channel: string, _listener: Listener) => undefined);
const on = mock((channel: string, listener: Listener) => {
  listeners.set(channel, listener);
});

mock.module("electron", () =>
  electronMock({
    ipcRenderer: { invoke, off, on, send },
    webUtils: { getPathForFile: () => "" },
  }),
);

import type {
  DownloadDoneEvent,
  WindowAttentionPayload,
} from "@mycadet/ipc-contract";
import {
  COMPANION_SET_UNPLACED_DICTATION_OFFER,
  NOTIFICATIONS_ACTION,
  NOTIFICATIONS_PREPARE_IDENTITY,
  NOTIFICATIONS_REGISTER_IDENTITY_PUBLISHER,
  NOTIFICATIONS_RESET_IDENTITIES,
  NOTIFICATIONS_SHOW,
  WINDOW_ATTENTION,
} from "@mycadet/ipc-contract";

const {
  bundleConfirmBridge,
  downloadsBridge,
  dictationOfferBridge,
  notificationsBridge,
  windowAttentionSubscriber,
} = await import("./preload/factories");

beforeEach(() => {
  invoke.mockClear();
  send.mockClear();
  off.mockClear();
  on.mockClear();
  // `listeners` is NOT cleared: the shared window-attention subscriber
  // registers its dispatcher at module load, before the first test.
});

test("notification preload works without crypto.randomUUID", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {},
  });
  try {
    expect(await notificationsBridge.registerIdentityPublisher?.()).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      NOTIFICATIONS_REGISTER_IDENTITY_PUBLISHER,
      {
        publisherSessionId: expect.any(String),
      },
    );
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("sends recovery offers and clears over the companion IPC channel", () => {
  const bridge = dictationOfferBridge;
  const offer = {
    text: "make this friendlier",
    reason: "paste-failed" as const,
  };
  bridge.setUnplacedDictationOffer(offer);
  bridge.setUnplacedDictationOffer(null);
  expect(send.mock.calls).toEqual([
    [COMPANION_SET_UNPLACED_DICTATION_OFFER, offer],
    [COMPANION_SET_UNPLACED_DICTATION_OFFER, null],
  ]);
});

test("creates the notification bridge with optional identity methods", async () => {
  const bridge = notificationsBridge;
  const scopeId = `scope:v1:${"a".repeat(64)}`;
  const identity = {
    scopeId,
    assistantId: "assistant-a",
    nativeSenderId: "native-a",
  };
  const showPayload = {
    category: "notificationIntent" as const,
    title: "Weekly plan",
    body: "Ready",
  };
  const preparePayload = {
    identity,
    scopeEpoch: 1,
    identityRevision: 1,
    name: "Alice",
    nameProvenance: "identity-store" as const,
  };
  const resetPayload = { scopeId, scopeEpoch: 2 };

  await bridge.show(showPayload);
  await bridge.prepareIdentity?.(preparePayload);
  await bridge.resetIdentities?.(resetPayload);

  const publisherSessionId = expect.any(String) as string;
  expect(invoke).toHaveBeenCalledWith(NOTIFICATIONS_SHOW, showPayload);
  expect(invoke).toHaveBeenCalledWith(NOTIFICATIONS_PREPARE_IDENTITY, {
    ...preparePayload,
    publisherSessionId,
  });
  expect(invoke).toHaveBeenCalledWith(NOTIFICATIONS_RESET_IDENTITIES, {
    ...resetPayload,
    publisherSessionId,
  });

  const received: unknown[] = [];
  const unsubscribe = bridge.onAction((event) => received.push(event));
  const action = { kind: "click" as const, conversationId: "conv-a" };
  listeners.get(NOTIFICATIONS_ACTION)?.({}, action);
  expect(received).toEqual([action]);
  unsubscribe();
  expect(off).toHaveBeenCalledWith(NOTIFICATIONS_ACTION, expect.any(Function));
});

test("creates the bundle confirmation IPC bridge", async () => {
  const bridge = bundleConfirmBridge;

  await bridge.getData();
  bridge.respond(true);

  expect(invoke).toHaveBeenCalledWith("cadet:bundleConfirm:getData");
  expect(send).toHaveBeenCalledWith("cadet:bundleConfirm:respond", true);
});

test("creates the downloads IPC bridge", async () => {
  const bridge = downloadsBridge;

  const received: DownloadDoneEvent[] = [];
  const unsubscribe = bridge.onDone((event) => received.push(event));
  await bridge.reveal("dl-1");

  expect(invoke).toHaveBeenCalledWith("cadet:downloads:reveal", "dl-1");
  expect(on).toHaveBeenCalledWith("cadet:downloads:done", expect.any(Function));
  listeners.get("cadet:downloads:done")?.(
    {},
    {
      id: "dl-1",
      filename: "report.pdf",
      state: "completed",
    },
  );
  expect(received).toEqual([
    { id: "dl-1", filename: "report.pdf", state: "completed" },
  ]);

  unsubscribe();
  expect(off).toHaveBeenCalledWith(
    "cadet:downloads:done",
    expect.any(Function),
  );
});

const ATTENDED: WindowAttentionPayload = {
  visible: true,
  focused: true,
  minimized: false,
};

const UNFOCUSED: WindowAttentionPayload = {
  visible: true,
  focused: false,
  minimized: false,
};

/** The WINDOW_ATTENTION listener the shared subscriber registered. */
const broadcast = (payload: WindowAttentionPayload): void => {
  const handler = listeners.get(WINDOW_ATTENTION);
  if (!handler) throw new Error("window-attention listener was not registered");
  handler({}, payload);
};

test("delivers broadcasts to a subscriber registered before the first one", () => {
  const received: WindowAttentionPayload[] = [];
  const unsubscribe = windowAttentionSubscriber((payload) =>
    received.push(payload),
  );

  expect(received).toEqual([]);

  broadcast(UNFOCUSED);

  expect(received).toEqual([UNFOCUSED]);
  unsubscribe();
});

test("replays the last window-attention payload to a late subscriber", () => {
  broadcast(ATTENDED);

  const received: WindowAttentionPayload[] = [];
  const unsubscribe = windowAttentionSubscriber((payload) =>
    received.push(payload),
  );

  expect(received).toEqual([ATTENDED]);
  unsubscribe();
});

test("replays the window-attention payload to every late subscriber", () => {
  broadcast(ATTENDED);

  const first: WindowAttentionPayload[] = [];
  const second: WindowAttentionPayload[] = [];
  const unsubscribeFirst = windowAttentionSubscriber((payload) =>
    first.push(payload),
  );
  const unsubscribeSecond = windowAttentionSubscriber((payload) =>
    second.push(payload),
  );

  expect(first).toEqual([ATTENDED]);
  expect(second).toEqual([ATTENDED]);
  unsubscribeFirst();
  unsubscribeSecond();
});

test("replays the latest window-attention payload, not the first", () => {
  broadcast(ATTENDED);
  broadcast(UNFOCUSED);

  const received: WindowAttentionPayload[] = [];
  const unsubscribe = windowAttentionSubscriber((payload) =>
    received.push(payload),
  );

  expect(received).toEqual([UNFOCUSED]);
  unsubscribe();
});

test("stops window-attention delivery once the subscriber unsubscribes", () => {
  const received: WindowAttentionPayload[] = [];
  const unsubscribe = windowAttentionSubscriber((payload) =>
    received.push(payload),
  );
  const replayedCount = received.length;
  unsubscribe();

  broadcast(ATTENDED);

  expect(received.length).toBe(replayedCount);
});

test("does not deliver window attention after the subscriber unsubscribes", () => {
  const received: WindowAttentionPayload[] = [];
  const unsubscribe = windowAttentionSubscriber((payload) =>
    received.push(payload),
  );
  const replayedCount = received.length;
  unsubscribe();

  broadcast(ATTENDED);

  expect(received.length).toBe(replayedCount);
});

test("skips a window-attention subscriber that unsubscribes mid-broadcast", () => {
  const second: WindowAttentionPayload[] = [];
  let unsubscribeSecond = (): void => undefined;
  const unsubscribeFirst = windowAttentionSubscriber(() => {
    unsubscribeSecond();
  });
  // The shared subscriber replays its latest payload to a new callback
  // synchronously; drain that replay before the broadcast under test.
  unsubscribeSecond = windowAttentionSubscriber((payload) =>
    second.push(payload),
  );
  const replayedCount = second.length;

  broadcast(ATTENDED);

  // The first subscriber removed this one mid-dispatch, so the broadcast
  // delivers nothing new.
  expect(second.length).toBe(replayedCount);
  unsubscribeFirst();
  unsubscribeSecond();
});
