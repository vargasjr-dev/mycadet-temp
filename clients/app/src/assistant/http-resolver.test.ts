import { afterEach, expect, spyOn, test } from "bun:test";
import { createHttpAssistantResolver } from "./http-resolver";

const request = spyOn(globalThis, "fetch");
afterEach(() => {
  request.mockReset();
});

test("uses the host endpoint, selected assistant, and cancellation signal", async () => {
  request.mockResolvedValue(new Response(JSON.stringify({ status: "empty" })));
  const controller = new AbortController();
  const resolve = createHttpAssistantResolver(
    "/resolve?scope=admin",
    "https://site.example.com",
  );
  expect(
    await resolve({ assistantId: "assistant-1", signal: controller.signal }),
  ).toEqual({ status: "empty" });
  expect(request).toHaveBeenCalledWith(
    new URL(
      "https://site.example.com/resolve?scope=admin&assistantId=assistant-1",
    ),
    { signal: controller.signal, credentials: "same-origin" },
  );
});

test("maps only 401 to unauthenticated and rejects server failures", async () => {
  const resolve = createHttpAssistantResolver(
    "/resolve",
    "https://site.example.com",
  );
  request.mockResolvedValueOnce(new Response(null, { status: 401 }));
  expect(await resolve({ signal: new AbortController().signal })).toEqual({
    status: "unauthenticated",
  });
  request.mockResolvedValueOnce(new Response(null, { status: 500 }));
  await expect(
    resolve({ signal: new AbortController().signal }),
  ).rejects.toThrow("500");
});

test("an unconfigured endpoint never requests an invented API route", async () => {
  await expect(
    createHttpAssistantResolver(
      "",
      "https://site.example.com",
    )({ signal: new AbortController().signal }),
  ).rejects.toThrow("Configure");
  expect(request).not.toHaveBeenCalled();
});
