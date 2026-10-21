import { afterEach, expect, test } from "bun:test";

import {
  __resetConnectDialogForTesting,
  useConnectDialogStore,
} from "./connect-dialog-store";

afterEach(() => __resetConnectDialogForTesting());

test("opens empty by default and clears any parked deep-link payload", () => {
  useConnectDialogStore.getState().openConnectDialog({
    initialAddress: "https://assistant.example.com",
    guidanceKind: "generic",
  });
  expect(useConnectDialogStore.getState().open).toBe(true);
  expect(useConnectDialogStore.getState().initialAddress).toBe(
    "https://assistant.example.com",
  );
  expect(useConnectDialogStore.getState().guidanceKind).toBe("generic");

  // A manual open carries no payload: a stale deep-link prefill never
  // resurfaces.
  useConnectDialogStore.getState().openConnectDialog();
  expect(useConnectDialogStore.getState().open).toBe(true);
  expect(useConnectDialogStore.getState().initialAddress).toBeNull();
  expect(useConnectDialogStore.getState().guidanceKind).toBeNull();
});

test("closing clears the parked payload along with the open flag", () => {
  useConnectDialogStore.getState().openConnectDialog({
    initialAddress: "cadet://connect?link=secret",
  });
  useConnectDialogStore.getState().closeConnectDialog();
  expect(useConnectDialogStore.getState().open).toBe(false);
  expect(useConnectDialogStore.getState().initialAddress).toBeNull();
  expect(useConnectDialogStore.getState().guidanceKind).toBeNull();
});

test("the deep-link drain latch is one-way for the renderer's lifetime", () => {
  expect(useConnectDialogStore.getState().deepLinkDrainSettled).toBe(false);
  useConnectDialogStore.getState().markDeepLinkDrainSettled();
  expect(useConnectDialogStore.getState().deepLinkDrainSettled).toBe(true);
  // Closing a dialog does not unwind the latch.
  useConnectDialogStore.getState().openConnectDialog();
  useConnectDialogStore.getState().closeConnectDialog();
  expect(useConnectDialogStore.getState().deepLinkDrainSettled).toBe(true);
});
