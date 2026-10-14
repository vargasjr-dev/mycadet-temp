import { afterEach, expect, mock, test } from "bun:test";
let result: unknown = { ok: true, data: [{ id: "assistant-1" }] };
let returningUser = false;
const list = mock(async () => result);
const refresh = mock(async () => {});
const checkout = { save: () => {}, clear: () => {} };
mock.module("@web/assistant/api", () => ({ listAssistants: list }));
mock.module("@web/assistant/cloud-assistants-sync", () => ({
  refreshCloudAssistantsIfStale: refresh,
}));
mock.module("@app/runtime/native-auth-context", () => ({
  nativeAuthContext: { read: () => ({ returningUser, checkout }) },
}));
const { assistantAuthHandoff } = await import("./assistant-auth-handoff");
afterEach(() => {
  result = { ok: true, data: [{ id: "assistant-1" }] };
  returningUser = false;
  mock.clearAllMocks();
});
test("presence is best effort on empty, rejected, and unreachable assistant lists", async () => {
  expect(await assistantAuthHandoff.hasAssistants()).toBe(true);
  result = { ok: true, data: [] };
  expect(await assistantAuthHandoff.hasAssistants()).toBe(false);
  result = { ok: false, data: [{ id: "assistant-1" }] };
  expect(await assistantAuthHandoff.hasAssistants()).toBe(false);
  result = { ok: true, data: "not-an-array" };
  expect(await assistantAuthHandoff.hasAssistants()).toBe(false);
  result = { ok: true, data: [{}] };
  expect(await assistantAuthHandoff.hasAssistants()).toBe(false);
  list.mockRejectedValueOnce(new Error("offline"));
  expect(await assistantAuthHandoff.hasAssistants()).toBe(false);
});
test("handoff retains the shared checkout writer and reads live assistant facts", async () => {
  await assistantAuthHandoff.refresh();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(assistantAuthHandoff.read()).toEqual({
    returningUser: false,
    checkout,
  });
  returningUser = true;
  expect(assistantAuthHandoff.read()).toEqual({
    returningUser: true,
    checkout,
  });
});
