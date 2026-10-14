import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { listAssistants } from "./api";
const fetchSpy = spyOn(globalThis, "fetch");
const originalBridge = Object.getOwnPropertyDescriptor(window, "cadet");
const selectionKey = "cadet_active_organization_id";
const page = (results: unknown[], next: string | null = null) =>
  new Response(JSON.stringify({ results, next }));
function organizations(ids = ["org-1"], next: string | null = null) {
  fetchSpy.mockResolvedValueOnce(
    page(
      ids.map((id) => ({ id })),
      next,
    ),
  );
}
beforeEach(() => {
  fetchSpy.mockReset();
  Reflect.deleteProperty(window, "cadet");
  sessionStorage.removeItem(selectionKey);
});
afterEach(() => {
  sessionStorage.removeItem(selectionKey);
  if (originalBridge) {
    Object.defineProperty(window, "cadet", originalBridge);
  } else {
    Reflect.deleteProperty(window, "cadet");
  }
});
afterAll(() => fetchSpy.mockRestore());
test("browser listing uses app-owned HTTP with cookies and a membership-validated organization", async () => {
  sessionStorage.setItem(selectionKey, "org-2");
  organizations(["org-1", "org-2"]);
  fetchSpy.mockResolvedValueOnce(
    page([
      {
        id: "assistant-1",
        name: "Example Assistant",
        avatar_url: "ignored",
        configuration: {},
      },
    ]),
  );
  expect(await listAssistants()).toEqual({
    ok: true,
    status: 200,
    data: [{ id: "assistant-1", name: "Example Assistant" }],
  });
  expect(fetchSpy.mock.calls[0]?.[0]).toBe(
    "/v1/organizations/?limit=100&offset=0",
  );
  expect(fetchSpy.mock.calls[1]?.[0]).toBe(
    "/v1/assistants/?hosting=all&limit=100&offset=0",
  );
  const headers = new Headers(fetchSpy.mock.calls[1]?.[1]?.headers);
  expect(headers.get("Cadet-Organization-Id")).toBe("org-2");
  expect(headers.get("X-Session-Token")).toBeNull();
  expect(headers.get("Authorization")).toBeNull();
  expect(headers.get("Accept-Language")).not.toBeNull();
  expect(fetchSpy.mock.calls[1]?.[1]?.credentials).toBe("same-origin");
});
test("desktop listing reads the current native account token for both organization and assistant requests", async () => {
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: {
      platform: "electron",
      auth: { getSessionToken: () => "native-session-token" },
    },
  });
  organizations();
  fetchSpy.mockResolvedValueOnce(page([]));
  expect((await listAssistants()).ok).toBe(true);
  for (const call of fetchSpy.mock.calls) {
    expect(new Headers(call[1]?.headers).get("X-Session-Token")).toBe(
      "native-session-token",
    );
  }
});
test("all assistant pages use one organization and never follow the server's next URL", async () => {
  organizations();
  fetchSpy.mockResolvedValueOnce(
    page([{ id: "assistant-1" }], "https://external.example/next"),
  );
  fetchSpy.mockResolvedValueOnce(page([{ id: "assistant-2" }]));
  const result = await listAssistants();
  expect(result).toMatchObject({
    ok: true,
    data: [{ id: "assistant-1" }, { id: "assistant-2" }],
  });
  expect(fetchSpy.mock.calls[2]?.[0]).toBe(
    "/v1/assistants/?hosting=all&limit=100&offset=1",
  );
  for (const call of fetchSpy.mock.calls.slice(1)) {
    expect(new Headers(call[1]?.headers).get("Cadet-Organization-Id")).toBe(
      "org-1",
    );
  }
});
test("organization resolution fetches every page before choosing the active selection", async () => {
  sessionStorage.setItem(selectionKey, "org-2");
  organizations(["org-1"], "/v1/organizations/?offset=1");
  organizations(["org-2"]);
  fetchSpy.mockResolvedValueOnce(page([]));
  await listAssistants();
  expect(fetchSpy.mock.calls[1]?.[0]).toBe(
    "/v1/organizations/?limit=100&offset=1",
  );
  expect(
    new Headers(fetchSpy.mock.calls[2]?.[1]?.headers).get(
      "Cadet-Organization-Id",
    ),
  ).toBe("org-2");
});
test("a selection from another account cannot scope the request and membership is not cached", async () => {
  sessionStorage.setItem(selectionKey, "old-org");
  organizations(["org-1"]);
  fetchSpy.mockResolvedValueOnce(page([]));
  await listAssistants();
  organizations(["org-2"]);
  fetchSpy.mockResolvedValueOnce(page([]));
  await listAssistants();
  expect(
    new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get(
      "Cadet-Organization-Id",
    ),
  ).toBe("org-1");
  expect(
    new Headers(fetchSpy.mock.calls[3]?.[1]?.headers).get(
      "Cadet-Organization-Id",
    ),
  ).toBe("org-2");
  expect(sessionStorage.getItem(selectionKey)).toBe("old-org");
});
test("no organization or rejected membership returns a failure without listing assistants", async () => {
  organizations([]);
  expect((await listAssistants()).ok).toBe(false);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValueOnce(
    new Response('{"detail":"Authentication required."}', { status: 401 }),
  );
  expect(await listAssistants()).toEqual({
    ok: false,
    status: 401,
    error: { detail: "Authentication required." },
  });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
test("a later assistant-page failure cannot return a partial list as authoritative", async () => {
  organizations();
  fetchSpy.mockResolvedValueOnce(page([{ id: "assistant-1" }], "next"));
  fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 503 }));
  const result = await listAssistants();
  expect(result).toMatchObject({ ok: false, status: 503 });
  expect("data" in result).toBe(false);
});
for (const payload of [
  null,
  {},
  { results: [{}] },
  { results: "invalid" },
  { results: [{ id: "" }] },
]) {
  test(`malformed assistant response ${JSON.stringify(payload)} fails closed`, async () => {
    organizations();
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(payload)));
    expect(await listAssistants()).toMatchObject({
      ok: false,
      status: 200,
      error: { detail: "Invalid cloud response." },
    });
  });
}
test("assistant pagination is bounded and an empty page terminates a next chain", async () => {
  organizations();
  for (let i = 0; i < 20; i++) {
    fetchSpy.mockResolvedValueOnce(page([{ id: `assistant-${i}` }], "next"));
  }
  const result = await listAssistants();
  expect(result).toMatchObject({
    ok: false,
    error: { detail: "Assistant list exceeded the page cap." },
  });
  expect("data" in result).toBe(false);
  expect(fetchSpy).toHaveBeenCalledTimes(21);
  fetchSpy.mockReset();
  organizations();
  fetchSpy.mockResolvedValueOnce(page([], "next"));
  expect(await listAssistants()).toMatchObject({ ok: true, data: [] });
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});
test("organization pagination is bounded without using a partial membership list", async () => {
  for (let i = 0; i < 20; i++) {
    organizations([`org-${i}`], "next");
  }
  expect(await listAssistants()).toMatchObject({
    ok: false,
    error: { detail: "Organization list exceeded the page cap." },
  });
  expect(fetchSpy).toHaveBeenCalledTimes(20);
});
test("unavailable selection storage falls back to validated membership", async () => {
  const getItem = sessionStorage.getItem;
  sessionStorage.getItem = () => {
    throw new Error("storage unavailable");
  };
  try {
    organizations();
    fetchSpy.mockResolvedValueOnce(page([]));
    expect((await listAssistants()).ok).toBe(true);
    expect(
      new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get(
        "Cadet-Organization-Id",
      ),
    ).toBe("org-1");
  } finally {
    sessionStorage.getItem = getItem;
  }
});
test("transport failures and aborts return failures and propagate the caller's signal", async () => {
  const controller = new AbortController();
  fetchSpy.mockRejectedValueOnce(new Error("offline"));
  expect(await listAssistants({ signal: controller.signal })).toMatchObject({
    ok: false,
    status: 0,
  });
  expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  fetchSpy.mockReset();
  controller.abort();
  fetchSpy.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
  expect(await listAssistants({ signal: controller.signal })).toMatchObject({
    ok: false,
    status: 0,
  });
  expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

test("malformed organization membership cannot stamp assistant requests", async () => {
  fetchSpy.mockResolvedValueOnce(page([{}]));
  expect(await listAssistants()).toMatchObject({ ok: false, status: 200 });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
