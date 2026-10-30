import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, mock, test } from "bun:test";

const publish = mock((_name: string) => {});
mock.module("@/runtime/identity", () => ({ setAssistantName: publish }));
mock.module("@/stores/assistant-identity-store", () => ({
  useAssistantIdentityStore: { use: { name: () => "Example Assistant" } },
}));

const { useElectronIdentitySync } =
  await import("./use-electron-identity-sync");
afterEach(cleanup);

test("publishes the cached identity once the store holds a name", () => {
  renderHook(() => useElectronIdentitySync());
  expect(publish).toHaveBeenLastCalledWith("Example Assistant");
});
