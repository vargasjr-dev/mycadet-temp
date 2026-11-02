import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveAssistant } from "./resolve-assistant";
import type { AssistantResolution } from "./resolution-contract";

const request = spyOn(globalThis, "fetch");
afterEach(() => {
  request.mockReset();
});
const ready = {
  status: "ready",
  assistant: {
    id: "assistant-1",
    version: "1.2.3",
    url: "assistant/",
  },
};
const options = () => ({
  origin: "https://site.example.com",
  signal: new AbortController().signal,
});
function json(value: unknown) {
  return new Response(JSON.stringify(value));
}

test("the resolution is one call: GET v1/assistant on the configured prefix, with cookies", async () => {
  request.mockResolvedValue(json(ready));
  const input = {
    ...options(),
    apiBaseUrl: "https://assistant.example.com/cloud/tenant/",
  };
  const result = await resolveAssistant(input);
  expect(result).toEqual({
    status: "ready",
    assistant: {
      id: ready.assistant.id,
      version: ready.assistant.version,
      url: "https://assistant.example.com/cloud/tenant/assistant/",
    },
  });
  const [url, init] = request.mock.calls[0];
  expect(String(url)).toBe(
    "https://assistant.example.com/cloud/tenant/v1/assistant",
  );
  expect(init?.credentials).toBe("include");
  expect(init?.signal).toBe(input.signal);
});

test("the union passes through untouched except the ready url's absolutization", async () => {
  const bodies: AssistantResolution[] = [
    { status: "empty" },
    { status: "notReady" },
    { status: "unavailable" },
    { status: "unauthenticated" },
    {
      status: "selection",
      assistants: [
        { id: "one", name: "One" },
        // The contract's own name transform fills the blank row.
        { id: "two", name: "New Assistant", remote: "local" },
      ],
    },
  ];
  for (const body of bodies) {
    request.mockResolvedValueOnce(json(body));
    expect(await resolveAssistant(options())).toEqual(body);
  }
  // An absolute ready url is kept verbatim (a cloud entry's platform url).
  request.mockResolvedValueOnce(
    json({
      status: "ready",
      assistant: {
        id: "assistant-1",
        version: "1.2.3",
        url: "https://platform.example/assistant/",
      },
    }),
  );
  request.mockResolvedValueOnce(
    json({
      status: "ready",
      assistant: {
        id: "assistant-1",
        version: "1.2.3",
        url: "https://platform.example/assistant/",
      },
    }),
  );
  expect((await resolveAssistant(options())).status).toBe("ready");
  expect(
    (await resolveAssistant(options())) as { assistant: { url: string } },
  ).toMatchObject({
    assistant: { url: "https://platform.example/assistant/" },
  });
});

test("a 401 resolution is unauthenticated; forbidden and server failures remain errors", async () => {
  for (const status of [401, 403, 500]) {
    request.mockResolvedValueOnce(new Response(null, { status }));
    const result = resolveAssistant(options());
    if (status === 401) {
      expect(await result).toEqual({ status: "unauthenticated" });
    } else {
      await expect(result).rejects.toThrow(String(status));
    }
  }
});

test("409 and 410 never mount a stale UI, regardless of body", async () => {
  for (const [code, status] of [
    [409, "notReady"],
    [410, "unavailable"],
  ] as const) {
    for (const body of [null, JSON.stringify(ready), "not JSON"]) {
      request.mockResolvedValueOnce(new Response(body, { status: code }));
      expect(await resolveAssistant(options())).toEqual({ status });
    }
  }
});

test("validates response fields and API URL configuration", async () => {
  for (const payload of [
    { ...ready, assistant: { ...ready.assistant, url: "javascript:alert(1)" } },
    { ...ready, assistant: { ...ready.assistant, url: null } },
    { ...ready, assistant: { ...ready.assistant, version: null } },
    { ...ready, assistant: { ...ready.assistant, version: "" } },
    { ...ready, assistant: { ...ready.assistant, id: "" } },
    { ...ready, assistant: { ...ready.assistant, url: "/no/assistant/here" } },
    { status: "ready", assistant: undefined },
    { status: "bogus" },
    {},
    null,
  ]) {
    request.mockResolvedValueOnce(json(payload));
    await expect(resolveAssistant(options())).rejects.toThrow();
  }
  request.mockClear();
  for (const apiBaseUrl of [
    "//attacker.example",
    "https://user:pass@api.example",
    "/api?token=secret",
  ]) {
    await expect(
      resolveAssistant({ ...options(), apiBaseUrl }),
    ).rejects.toThrow();
  }
  expect(request).not.toHaveBeenCalled();
});
