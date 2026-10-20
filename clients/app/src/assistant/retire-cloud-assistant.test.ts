import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import {
  SELECTED_ASSISTANT_STORAGE_KEY,
  writeSelectedAssistantId,
} from "./selected-assistant-storage";
import { retireCloudAssistant } from "./retire-cloud-assistant";

const request = spyOn(globalThis, "fetch");

beforeAll(() => {
  // The csrf bootstrap reads the cookie before every mutation; seed it so no
  // test fetch is spent (or delayed) on a session probe.
  document.cookie = "csrftoken=test; path=/";
});
afterAll(() => request.mockRestore());
afterEach(() => {
  localStorage.removeItem(SELECTED_ASSISTANT_STORAGE_KEY);
});

test("a retire deletes through the cloud's retire route and reports success", async () => {
  request.mockResolvedValueOnce(new Response(null, { status: 204 }));
  const outcome = await retireCloudAssistant("assistant-1");
  expect(outcome).toEqual({ ok: true });
  expect(request).toHaveBeenCalledTimes(1);
  const [url, init] = request.mock.calls[0];
  expect(String(url)).toBe("/v1/assistants/assistant-1/retire/");
  expect(init?.method).toBe("DELETE");
});

test("a 404 means the assistant is already gone and still succeeds", async () => {
  request.mockResolvedValueOnce(
    Response.json({ detail: "Not found." }, { status: 404 }),
  );
  const outcome = await retireCloudAssistant("assistant-1");
  expect(outcome).toEqual({ ok: true });
});

test("another failure surfaces the cloud's detail", async () => {
  request.mockResolvedValueOnce(
    Response.json(
      { detail: "You do not own this assistant." },
      { status: 403 },
    ),
  );
  const outcome = await retireCloudAssistant("assistant-1");
  expect(outcome).toEqual({
    ok: false,
    error: "You do not own this assistant.",
  });
});

test("retiring the stored selection clears the stored slot", async () => {
  writeSelectedAssistantId("assistant-1");
  request.mockResolvedValueOnce(new Response(null, { status: 204 }));
  const outcome = await retireCloudAssistant("assistant-1");
  expect(outcome).toEqual({ ok: true });
  expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBeNull();
});

test("retiring another assistant leaves the stored selection alone", async () => {
  writeSelectedAssistantId("assistant-2");
  request.mockResolvedValueOnce(new Response(null, { status: 204 }));
  const outcome = await retireCloudAssistant("assistant-1");
  expect(outcome).toEqual({ ok: true });
  expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBe(
    "assistant-2",
  );
});
