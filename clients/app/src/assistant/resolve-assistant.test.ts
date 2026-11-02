import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveAssistant } from "./resolve-assistant";

const request = spyOn(globalThis, "fetch");
afterEach(() => {
  request.mockReset();
});
const detail = {
  id: "assistant-1",
  status: "active",
  version: "1.2.3",
  url: "/web/1.2.3/assistant/",
};
const options = () => ({
  origin: "https://site.example.com",
  signal: new AbortController().signal,
});
function json(value: unknown) {
  return new Response(JSON.stringify(value));
}
/** The gateway's health answer: authenticated, no version stamp. */
const healthOk = () => json({ status: "ok", authenticated: true });

test("gets a single assistant under the configured API prefix with cookies", async () => {
  request.mockResolvedValueOnce(healthOk()).mockResolvedValue(json(detail));
  const input = {
    ...options(),
    apiBaseUrl: "https://assistant.example.com/cloud/tenant/",
    assistantId: "assistant-1",
  };
  const result = await resolveAssistant(input);
  expect(result).toEqual({
    status: "ready",
    assistant: {
      id: detail.id,
      version: detail.version,
      url: "https://assistant.example.com/web/1.2.3/assistant/",
    },
  });
  // The identity ping rides the same configured prefix, first.
  expect(String(request.mock.calls[0][0])).toBe(
    "https://assistant.example.com/cloud/tenant/healthz",
  );
  const [url, init] = request.mock.calls[1];
  expect(String(url)).toBe(
    "https://assistant.example.com/cloud/tenant/v1/assistants/assistant-1/",
  );
  expect(init?.credentials).toBe("include");
  expect(init?.signal).toBe(input.signal);
});

test("uses the existing list to select one assistant and never calls a resolve endpoint", async () => {
  request
    .mockResolvedValueOnce(healthOk())
    .mockResolvedValueOnce(json({ results: [{ id: detail.id }] }))
    .mockResolvedValueOnce(json(detail));
  expect((await resolveAssistant(options())).status).toBe("ready");
  expect(request.mock.calls.map(([url]) => String(url))).toEqual([
    "https://site.example.com/healthz",
    "https://site.example.com/v1/assistants/?limit=100&offset=0",
    "https://site.example.com/v1/assistants/assistant-1/",
  ]);
});

test("empty and multiple lists return states without choosing an arbitrary assistant", async () => {
  request
    .mockResolvedValueOnce(healthOk())
    .mockResolvedValueOnce(json({ results: [] }));
  expect(await resolveAssistant(options())).toEqual({ status: "empty" });
  request.mockResolvedValueOnce(healthOk()).mockResolvedValueOnce(
    json({
      results: [
        { id: "one", name: "One" },
        { id: "two", name: "Two" },
      ],
    }),
  );
  expect((await resolveAssistant(options())).status).toBe("selection");
  expect(request).toHaveBeenCalledTimes(4);
});

test("pagination stays on the configured origin instead of following response URLs", async () => {
  request
    .mockResolvedValueOnce(healthOk())
    .mockResolvedValueOnce(
      json({
        results: [{ id: "one" }],
        next: "https://elsewhere.example/private",
      }),
    )
    .mockResolvedValueOnce(json({ results: [{ id: "two" }], next: null }));
  expect(
    (await resolveAssistant({ ...options(), apiBaseUrl: "/admin/api" })).status,
  ).toBe("selection");
  expect(String(request.mock.calls[2][0])).toBe(
    "https://site.example.com/admin/api/v1/assistants/?limit=100&offset=1",
  );
});

test("401 is unauthenticated; forbidden and server failures remain errors", async () => {
  for (const status of [401, 403, 500]) {
    request.mockResolvedValueOnce(healthOk());
    request.mockResolvedValueOnce(new Response(null, { status }));
    const result = resolveAssistant({ ...options(), assistantId: detail.id });
    if (status === 401) {
      expect(await result).toEqual({ status: "unauthenticated" });
    } else {
      await expect(result).rejects.toThrow(String(status));
    }
  }
});

test("validates identities, response fields, and API URL configuration", async () => {
  for (const payload of [
    { ...detail, id: "other" },
    { ...detail, url: "javascript:alert(1)" },
    { ...detail, url: null },
    { ...detail, version: null },
    { ...detail, version: "" },
    { ...detail, status: "initializing" },
    { ...detail, status: "archived" },
    {},
    null,
  ]) {
    request.mockResolvedValueOnce(healthOk());
    request.mockResolvedValueOnce(json(payload));
    await expect(
      resolveAssistant({ ...options(), assistantId: detail.id }),
    ).rejects.toThrow();
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

test("409 and 410 detail responses never mount a stale UI, regardless of body", async () => {
  for (const [code, status] of [
    [409, "notReady"],
    [410, "unavailable"],
  ] as const) {
    for (const body of [null, JSON.stringify(detail), "not JSON"]) {
      request.mockResolvedValueOnce(healthOk());
      request.mockResolvedValueOnce(new Response(body, { status: code }));
      expect(
        await resolveAssistant({ ...options(), assistantId: detail.id }),
      ).toEqual({ status });
    }
  }
});

test("409 and 410 on the list remain errors", async () => {
  for (const status of [409, 410]) {
    request.mockResolvedValueOnce(healthOk());
    request.mockResolvedValueOnce(new Response(null, { status }));
    await expect(resolveAssistant(options())).rejects.toThrow(String(status));
  }
});

test("relative iframe URLs retain the host's API prefix", async () => {
  request
    .mockResolvedValueOnce(healthOk())
    .mockResolvedValue(json({ ...detail, url: "web/1.2.3/assistant/" }));
  expect(
    await resolveAssistant({
      ...options(),
      apiBaseUrl: "https://assistant.example.com/admin/proxy/",
      assistantId: detail.id,
    }),
  ).toEqual({
    status: "ready",
    assistant: {
      id: detail.id,
      version: "1.2.3",
      url: "https://assistant.example.com/admin/proxy/web/1.2.3/assistant/",
    },
  });
});

test("an unauthenticated health verdict gates the shell before any /v1 call", async () => {
  request.mockResolvedValueOnce(
    json({ status: "ok", version: "9.9.9", authenticated: false }),
  );
  expect(await resolveAssistant(options())).toEqual({
    status: "unauthenticated",
  });
  // The iframe must never mount on an unverified session: no assistant
  // request fires at all.
  expect(request).toHaveBeenCalledTimes(1);
});

test("the gateway's own version stamp wins over the detail's", async () => {
  request
    .mockResolvedValueOnce(
      json({ status: "ok", version: "9.9.9", authenticated: true }),
    )
    .mockResolvedValueOnce(json(detail));
  expect(
    await resolveAssistant({ ...options(), assistantId: detail.id }),
  ).toEqual({
    status: "ready",
    assistant: {
      id: detail.id,
      version: "9.9.9",
      url: `https://site.example.com/web/1.2.3/assistant/`,
    },
  });
});
