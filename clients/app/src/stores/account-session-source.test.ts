import { expect, mock, test } from "bun:test";
import { createAccountSessionSource } from "./account-session-source";
import type { AccountUser } from "./auth-state";
import type { AllauthResult, SessionSchema } from "@app/lib/auth/auth-response";
import type { z } from "zod";

type Result = AllauthResult<z.infer<typeof SessionSchema>>;
const user: AccountUser = {
  kind: "cloud",
  id: "cloud-user",
  username: null,
  email: "person@example.com",
  isStaff: false,
  firstName: "Person",
  lastName: "",
};
const success: Result = {
  ok: true,
  data: {
    user: { id: "cloud-user", email: user.email!, first_name: "Person" },
  },
};
function setup(cached: AccountUser | null = null) {
  const getSession = mock(async (): Promise<Result> => success);
  const write = mock((_user: AccountUser) => {});
  const clear = mock(() => {});
  const synchronizeWeb = mock(async () => true);
  const logout = mock(async () => {});
  const source = createAccountSessionSource({
    getSession,
    snapshot: { read: () => cached, write, clear },
    synchronizeWeb,
    logout,
  });
  return { source, getSession, write, clear, synchronizeWeb, logout };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("post-auth refresh supersedes the boot probe, deduplicates explicit refreshes, and maps user fields", async () => {
  const { source, getSession, write, synchronizeWeb } = setup();
  const probe = deferred<Result>();
  getSession.mockImplementationOnce(() => probe.promise);
  getSession.mockImplementationOnce(async () => success);
  const first = source.getSnapshot().initSession();
  const second = source.getSnapshot().initSession();
  expect(second).toBe(first);
  const refresh = source.getSnapshot().refreshSession();
  const otherRefresh = source.getSnapshot().refreshSession();
  expect(getSession).toHaveBeenCalledTimes(2);
  probe.resolve({ ok: false, status: 401, errors: [] });
  await Promise.all([first, second, refresh, otherRefresh]);
  expect(source.getSnapshot()).toMatchObject({
    user,
    sessionStatus: "authenticated",
    cloudSession: "present",
  });
  expect(write).toHaveBeenCalledWith(user);
  expect(synchronizeWeb).toHaveBeenCalledTimes(1);
});
for (const status of [401, 403, 410])
  test(`authoritative ${status} clears the offline account`, async () => {
    const { source, getSession, clear } = setup(user);
    getSession.mockResolvedValueOnce({ ok: false, status, errors: [] });
    await source.getSnapshot().initSession();
    expect(source.getSnapshot()).toMatchObject({
      user: null,
      sessionStatus: "unauthenticated",
      cloudSession: "absent",
    });
    expect(clear).toHaveBeenCalledTimes(1);
  });
for (const status of [undefined, 429, 502])
  test(`transient ${status} restores a cloud account and preserves it on subsequent failures`, async () => {
    const { source, getSession, clear } = setup(user);
    getSession.mockResolvedValue({ ok: false, status, errors: [] });
    await source.getSnapshot().initSession();
    expect(source.getSnapshot()).toMatchObject({
      user,
      sessionStatus: "authenticated",
      cloudSession: "present",
    });
    await source.observeSession();
    expect(source.getSnapshot().user).toEqual(user);
    expect(clear).not.toHaveBeenCalled();
  });
test("a gateway-only snapshot cannot sign into the cloud account", async () => {
  const { source, getSession } = setup({ ...user, kind: "local" });
  getSession.mockRejectedValueOnce(new TypeError("offline"));
  await source.getSnapshot().initSession();
  expect(source.getSnapshot()).toMatchObject({
    user: null,
    sessionStatus: "unauthenticated",
    cloudSession: "unknown",
  });
});
test("logout supersedes an in-flight success and blocks probes during cleanup", async () => {
  const { source, getSession, write, logout, clear } = setup();
  const probe = deferred<Result>();
  const cleanup = deferred<void>();
  getSession.mockImplementationOnce(() => probe.promise);
  logout.mockImplementationOnce(() => cleanup.promise);
  const refresh = source.getSnapshot().refreshSession();
  const signOut = source.getSnapshot().logout();
  expect(source.getSnapshot().cloudSession).toBe("absent");
  expect(await source.observeSession()).toBe(false);
  probe.resolve(success);
  expect(await refresh).toBe(false);
  cleanup.resolve();
  await signOut;
  expect(write).not.toHaveBeenCalled();
  expect(clear).toHaveBeenCalledTimes(2);
  expect(source.getSnapshot().user).toBeNull();
  expect(await source.observeSession()).toBe(true);
});
test("a logout during web synchronization cannot return an authenticated result", async () => {
  const { source, synchronizeWeb } = setup();
  const sync = deferred<boolean>();
  synchronizeWeb.mockImplementationOnce(() => sync.promise);
  const refresh = source.getSnapshot().refreshSession();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await source.getSnapshot().logout();
  sync.resolve(true);
  expect(await refresh).toBe(false);
  expect(source.getSnapshot().sessionStatus).toBe("unauthenticated");
});

test("a successful anonymous response clears a cached cloud account", async () => {
  const { source, getSession, clear } = setup(user);
  getSession.mockResolvedValueOnce({ ok: true, data: { user: null } });
  await source.getSnapshot().initSession();
  expect(source.getSnapshot()).toMatchObject({
    user: null,
    sessionStatus: "unauthenticated",
    cloudSession: "absent",
  });
  expect(clear).toHaveBeenCalledTimes(1);
});

test("stalled account probes abort and restore only a last-known cloud account", async () => {
  let aborted = false;
  const source = createAccountSessionSource({
    getSession: (signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("timed out"));
        });
      }),
    snapshot: { read: () => user, write: () => {}, clear: () => {} },
    synchronizeWeb: async () => {},
    logout: async () => {},
    probeTimeoutMs: 5,
  });
  await source.getSnapshot().initSession();
  expect(aborted).toBe(true);
  expect(source.getSnapshot()).toMatchObject({
    user,
    sessionStatus: "authenticated",
    cloudSession: "present",
  });
});

test("shared cloud logout invalidates pending app probes until every cleanup scope finishes", async () => {
  const { source, getSession, write } = setup();
  const probe = deferred<Result>();
  getSession.mockImplementationOnce(() => probe.promise);
  const initial = source.getSnapshot().initSession();
  const first = source.beginExternalLogout();
  const second = source.beginExternalLogout();
  probe.resolve(success);
  await initial;
  expect(write).not.toHaveBeenCalled();
  first();
  first();
  expect(await source.observeSession()).toBe(false);
  second();
  expect(await source.observeSession()).toBe(true);
});

test("a newer account rejection wins while legacy synchronization is pending", async () => {
  const { source, getSession, synchronizeWeb } = setup();
  const sync = deferred<boolean>();
  synchronizeWeb.mockImplementationOnce(() => sync.promise);
  const refresh = source.getSnapshot().refreshSession();
  await new Promise((resolve) => setTimeout(resolve, 0));
  getSession.mockResolvedValueOnce({ ok: false, status: 401, errors: [] });
  await source.observeSession();
  sync.resolve(true);
  expect(await refresh).toBe(false);
});
