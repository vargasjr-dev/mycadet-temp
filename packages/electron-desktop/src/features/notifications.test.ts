/**
 * The Linux helper toast factory, whose whole job beyond delivery is the
 * sender: when the renderer sends an assistant's avatar, the toast is from
 * that assistant, so its name is the title, the conversation title drops to
 * the subtitle, and the picture travels as a file path the helper reads.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { electronMock } from "../../test-setup";

mock.module("electron", () =>
  electronMock({
    app: {
      getVersion: () => "0.0.0",
      getName: () => "Cadet",
      isPackaged: false,
      getAppPath: () => "/app",
      getPath: () => "/userData",
      once: () => undefined,
    },
    // The shared notifications module reaches these at import time; only the
    // helper factory is under test here.
    BrowserWindow: { getAllWindows: () => [] },
    nativeImage: { createFromBuffer: () => ({}) },
    Notification: class {
      static isSupported = () => true;
      on(): void {}
      show(): void {}
    },
  }),
);

interface HelperCall {
  method: string;
  params: Record<string, unknown>;
}
const calls: HelperCall[] = [];
mock.module("@mycadet/native-sidecar/supervisor", () => ({
  NativeSidecarClient: class {
    onNotification(): void {}
    call(method: string, params: Record<string, unknown>): Promise<unknown> {
      calls.push({ method, params });
      return Promise.resolve({ success: true });
    }
    shutdown(): void {}
  },
}));

let avatarStagingFailed = false;
const STAGED_AVATAR_PATH = "/userData/notification-avatars/abc.png";
const resolveNotificationAvatarPath = mock(() => {
  if (avatarStagingFailed) {
    // The shared path resolver logs and reports "no avatar" when staging
    // fails; that contract is the package suite's. Here the failure shape
    // is what the helper toast must survive.
    return null;
  }
  return STAGED_AVATAR_PATH;
});
mock.module("../notification-avatar-path", () => ({
  resolveNotificationAvatarPath,
}));

mock.module("../ipc", () => ({
  handle: () => undefined,
  handleSync: () => undefined,
  on: () => undefined,
}));
mock.module("../main-window", () => ({ ensureVisible: () => undefined }));
mock.module("../app-logger", () => ({
  getLogFilePaths: () => [],
  default: { warn: () => undefined, info: () => undefined },
}));

const { createHelperToastFactory } = await import("../features/notifications");

const AVATAR_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const AVATAR_HASH = "a".repeat(64);

const sender = {
  id: "assistant-1",
  name: "Aria",
  avatarPng: AVATAR_PNG,
  avatarHash: AVATAR_HASH,
};

const baseOptions = {
  title: "Weekly review",
  body: "Three items need you",
  silent: false,
  actions: [{ type: "button" as const, text: "View" }],
};

const showToast = async (
  options: Parameters<ReturnType<typeof createHelperToastFactory>>[0],
): Promise<void> => {
  const toast = createHelperToastFactory("/helper")(options);
  toast.show();
  // `show()` defers the call so a synchronous throw still acks as a failed
  // delivery, so the params land a couple of microtasks later.
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  calls.length = 0;
  avatarStagingFailed = false;
  resolveNotificationAvatarPath.mockClear();
});

describe("Linux helper toast factory", () => {
  test("posts a sender's toast under the assistant's name with the avatar file", async () => {
    await showToast({ ...baseOptions, sender });

    expect(resolveNotificationAvatarPath).toHaveBeenCalledWith(
      sender,
      "/userData",
      expect.objectContaining({ warn: expect.any(Function) }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("notifications/show");
    expect(calls[0]!.params).toMatchObject({
      title: "Aria",
      subtitle: "Weekly review",
      body: "Three items need you",
      avatarPath: STAGED_AVATAR_PATH,
      actions: [{ text: "View" }],
    });
  });

  test("keeps the conversation title and sends no avatar without a sender", async () => {
    await showToast(baseOptions);

    // The builder hands the sender decision to the shared path resolver;
    // a senderless toast carries neither subtitle nor avatar path.
    expect(resolveNotificationAvatarPath).toHaveBeenCalledWith(
      undefined,
      "/userData",
      expect.objectContaining({ warn: expect.any(Function) }),
    );
    expect(calls[0]!.params).toMatchObject({
      title: "Weekly review",
      body: "Three items need you",
    });
    expect(calls[0]!.params).not.toHaveProperty("subtitle");
    expect(calls[0]!.params).not.toHaveProperty("avatarPath");
  });

  test("falls back to the plain toast when the avatar cannot be staged", async () => {
    avatarStagingFailed = true;

    await showToast({ ...baseOptions, sender });

    expect(calls[0]!.params).toMatchObject({ title: "Weekly review" });
    expect(calls[0]!.params).not.toHaveProperty("avatarPath");
  });
});
