import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveAssistant } from "./resolve-assistant";

const request = spyOn(globalThis, "fetch");
afterEach(() => {
  request.mockReset();
});
const detail = {
  id: "assistant-1",
  status: "active",
  ui: { version: "1.2.3", entryUrl: "/web/1.2.3/assistant/" },
  runtime: { baseUrl: "/runtime/assistant-1/v1/" },
};
const options = () => ({
  origin: "https://site.example.com",
  signal: new AbortController().signal,
});
function json(value: unknown) {
  return new Response(JSON.stringify(value));
}

test("gets a single assistant under the configured API prefix with cookies and organization", async () => {
  request.mockResolvedValue(json(detail));
  const input = {
    ...options(),
    apiBaseUrl: "https://assistant.example.com/cloud/tenant/",
    organizationId: "org-1",
    assistantId: "assistant-1",
  };
  const result = await resolveAssistant(input);
  expect(result).toEqual({
    status: "ready",
    assistant: {
      id: detail.id,
      ui: {
        ...detail.ui,
        entryUrl: "https://assistant.example.com/web/1.2.3/assistant/",
      },
      runtime: {
        baseUrl: "https://assistant.example.com/runtime/assistant-1/v1/",
      },
    },
  });
  const [url, init] = request.mock.calls[0];
  expect(String(url)).toBe(
    "https://assistant.example.com/cloud/tenant/v1/assistants/assistant-1/",
  );
  expect(init?.credentials).toBe("include");
  expect(init?.signal).toBe(input.signal);
  expect(new Headers(init?.headers).get("Cadet-Organization-Id")).toBe("org-1");
});

test("uses the existing list to select one assistant and never calls a resolve endpoint", async () => {
  request
    .mockResolvedValueOnce(json({ results: [{ id: detail.id }] }))
    .mockResolvedValueOnce(json(detail));
  expect((await resolveAssistant(options())).status).toBe("ready");
  expect(request.mock.calls.map(([url]) => String(url))).toEqual([
    "https://site.example.com/v1/assistants/?limit=100&offset=0",
    "https://site.example.com/v1/assistants/assistant-1/",
  ]);
});

test("empty and multiple lists return states without choosing an arbitrary assistant", async () => {
  request.mockResolvedValueOnce(json({ results: [] }));
  expect(await resolveAssistant(options())).toEqual({ status: "empty" });
  request.mockResolvedValueOnce(
    json({
      results: [
        { id: "one", name: "One" },
        { id: "two", name: "Two" },
      ],
    }),
  );
  expect((await resolveAssistant(options())).status).toBe("selection");
  expect(request).toHaveBeenCalledTimes(2);
});

test("pagination stays on the configured origin instead of following response URLs", async () => {
  request
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
  expect(String(request.mock.calls[1][0])).toBe(
    "https://site.example.com/admin/api/v1/assistants/?limit=100&offset=1",
  );
});

test("401 is unauthenticated; forbidden and server failures remain errors", async () => {
  for (const status of [401, 403, 500]) {
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
    { ...detail, ui: { version: "1", entryUrl: "javascript:alert(1)" } },
    {},
    null,
  ]) {
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

test("non-running assistants do not mount a stale UI", async () => {
  request.mockResolvedValueOnce(
    json({ ...detail, status: "initializing", ui: null, runtime: null }),
  );
  expect(
    await resolveAssistant({ ...options(), assistantId: detail.id }),
  ).toEqual({ status: "starting" });
  request.mockResolvedValueOnce(json({ ...detail, status: "archived" }));
  expect(
    await resolveAssistant({ ...options(), assistantId: detail.id }),
  ).toEqual({ status: "unavailable" });
});

test("relative iframe and runtime URLs retain the host's API prefix", async () => {
  request.mockResolvedValue(
    json({
      ...detail,
      ui: { ...detail.ui, entryUrl: "web/1.2.3/assistant/" },
      runtime: { baseUrl: "v1/assistants/assistant-1/" },
    }),
  );
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
      ui: {
        version: "1.2.3",
        entryUrl:
          "https://assistant.example.com/admin/proxy/web/1.2.3/assistant/",
      },
      runtime: {
        baseUrl:
          "https://assistant.example.com/admin/proxy/v1/assistants/assistant-1/",
      },
    },
  });
});
