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
  createBundleConfirmBridge,
  createDownloadsBridge,
  createDictationOfferBridge,
  createNotificationsBridge,
  createWindowAttentionSubscriber,
} = await import("./preload/factories");

beforeEach(() => {
  invoke.mockClear();
  send.mockClear();
  off.mockClear();
  on.mockClear();
  listeners.clear();
});

test("notification preload works without crypto.randomUUID", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {},
  });
  try {
    const bridge = createNotificationsBridge();
    expect(await bridge.registerIdentityPublisher?.()).toBe(true);
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
  const bridge = createDictationOfferBridge();
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
  const bridge = createNotificationsBridge();
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

  const registration = invoke.mock.calls.find(
    ([channel]) => channel === NOTIFICATIONS_REGISTER_IDENTITY_PUBLISHER,
  );
  const publisherSessionId = (
    registration?.[1] as { publisherSessionId?: string } | undefined
  )?.publisherSessionId;
  expect(publisherSessionId).toBeString();
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
  const bridge = createBundleConfirmBridge();

  await bridge.getData();
  bridge.respond(true);

  expect(invoke).toHaveBeenCalledWith("cadet:bundleConfirm:getData");
  expect(send).toHaveBeenCalledWith("cadet:bundleConfirm:respond", true);
});

test("creates the downloads IPC bridge", async () => {
  const bridge = createDownloadsBridge();

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

/** The latest WINDOW_ATTENTION listener the factory registered. */
const broadcast = (payload: WindowAttentionPayload): void => {
  const handler = listeners.get(WINDOW_ATTENTION);
  if (!handler) throw new Error("window-attention listener was not registered");
  handler({}, payload);
};

test("delivers broadcasts to a subscriber registered before the first one", () => {
  const onWindowAttention = createWindowAttentionSubscriber();

  const received: WindowAttentionPayload[] = [];
  onWindowAttention((payload) => received.push(payload));

  expect(on).toHaveBeenCalledWith(WINDOW_ATTENTION, expect.any(Function));
  expect(received).toEqual([]);

  broadcast(UNFOCUSED);

  expect(received).toEqual([UNFOCUSED]);
});

test("replays the last window-attention payload to a late subscriber", () => {
  const onWindowAttention = createWindowAttentionSubscriber();

  broadcast(ATTENDED);

  const received: WindowAttentionPayload[] = [];
  onWindowAttention((payload) => received.push(payload));

  expect(received).toEqual([ATTENDED]);
});

test("replays the window-attention payload to every late subscriber", () => {
  const onWindowAttention = createWindowAttentionSubscriber();

  broadcast(ATTENDED);

  const first: WindowAttentionPayload[] = [];
  const second: WindowAttentionPayload[] = [];
  onWindowAttention((payload) => first.push(payload));
  onWindowAttention((payload) => second.push(payload));

  expect(first).toEqual([ATTENDED]);
  expect(second).toEqual([ATTENDED]);
});

test("replays the latest window-attention payload, not the first", () => {
  const onWindowAttention = createWindowAttentionSubscriber();

  broadcast(ATTENDED);
  broadcast(UNFOCUSED);

  const received: WindowAttentionPayload[] = [];
  onWindowAttention((payload) => received.push(payload));

  expect(received).toEqual([UNFOCUSED]);
});

test("stops window-attention delivery once the subscriber unsubscribes", () => {
  const onWindowAttention = createWindowAttentionSubscriber();

  const received: WindowAttentionPayload[] = [];
  const unsubscribe = onWindowAttention((payload) => received.push(payload));
  unsubscribe();

  broadcast(ATTENDED);

  expect(received).toEqual([]);
});

test("does not replay window attention after the subscriber unsubscribes", () => {
  const onWindowAttention = createWindowAttentionSubscriber();

  broadcast(ATTENDED);

  const received: WindowAttentionPayload[] = [];
  const unsubscribe = onWindowAttention((payload) => received.push(payload));
  unsubscribe();

  broadcast(UNFOCUSED);

  expect(received).toEqual([ATTENDED]);
});

test("skips a window-attention subscriber that unsubscribes mid-broadcast", () => {
  const onWindowAttention = createWindowAttentionSubscriber();

  const second: WindowAttentionPayload[] = [];
  let unsubscribeSecond = (): void => undefined;
  onWindowAttention(() => {
    unsubscribeSecond();
  });
  unsubscribeSecond = onWindowAttention((payload) => second.push(payload));

  broadcast(ATTENDED);

  expect(second).toEqual([]);
});
