import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { electronMock } from "../test-setup";

let isPackaged = false;
let appPath = process.cwd();

const protocolHandle = mock(() => undefined);
const cookieSet = mock(async () => undefined);
const cookieGet = mock(async (_filter: { url: string }) => []);
const netFetch = mock(async (url: string) => {
  const file = decodeURIComponent(new URL(url).pathname);
  const body = await fs.readFile(file, "utf8");
  return new Response(body, {
    headers: { "Content-Type": "text/html", "Content-Length": "999" },
  });
});

mock.module("electron", () =>
  electronMock({
    app: {
      get isPackaged() {
        return isPackaged;
      },
      getAppPath: () => appPath,
    },
    net: { fetch: netFetch },
    protocol: { handle: protocolHandle },
    session: {
      defaultSession: { cookies: { set: cookieSet, get: cookieGet } },
    },
  }),
);

import * as realLocalMode from "@mycadet/local-mode";

const forwardOperator = mock(async (): Promise<Response | null> => null);

mock.module("@mycadet/local-mode", () => ({
  ...realLocalMode,
  forwardOperatorRequest: forwardOperator,
}));
mock.module("./device-id", () => ({ getDeviceId: () => "device-7" }));
mock.module("./about", () => ({
  getVersionInfo: () => ({ version: "9.9.9" }),
}));
mock.module("./app-logger", () => ({
  default: { error: mock(), warning: mock(), info: mock(), warn: mock() },
}));
mock.module("@mycadet/local-mode", () => ({
  readLockfile: () => ({}),
  servedConfigFromLockfile: () => ({ assistantName: "A<ria" }),
}));

const { registerAppProtocol } = await import("./app-protocol-forward");

// Captured before any test redefines it, so the packaged test's win32
// platform mock restores the real one afterwards.
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  process,
  "platform",
) ?? {
  value: process.platform,
};

// The dev layout the handler derives on its own: `appPath` sits two
// levels under the fake repo root, so `clients/web/dist` is the web
// bundle and `clients/app/dist/standalone` the app shell.
let fakeRepo = "";
let handler: ((r: Request) => Promise<Response>) | undefined;

const register = async (): Promise<void> => {
  registerAppProtocol();
  const [, h] = protocolHandle.mock.calls.at(-1) as unknown as [
    string,
    (r: Request) => Promise<Response>,
  ];
  handler = h;
};

const writeRenderer = async (root: string, body: string): Promise<void> => {
  await fs.writeFile(
    path.join(root, "index.html"),
    `<html><head></head><body>${body}</body></html>`,
  );
};

afterEach(async () => {
  forwardOperator.mockClear();
  forwardOperator.mockResolvedValue(null);
  cookieSet.mockClear();
  isPackaged = false;
  delete (process as unknown as { resourcesPath?: string }).resourcesPath;
  Object.defineProperty(process, "platform", ORIGINAL_PLATFORM_DESCRIPTOR);
});

const setupDev = async (): Promise<void> => {
  fakeRepo = await fs.mkdtemp(path.join(os.tmpdir(), "apf-repo-"));
  const webRoot = path.join(fakeRepo, "clients", "web", "dist");
  const appRoot = path.join(fakeRepo, "clients", "app", "dist", "standalone");
  await fs.mkdir(path.join(webRoot, "assets"), { recursive: true });
  await fs.mkdir(appRoot, { recursive: true });
  await writeRenderer(webRoot, "web");
  await fs.writeFile(
    path.join(webRoot, "assets", "index.js"),
    "console.log(1)",
  );
  await writeRenderer(appRoot, "shell");
  appPath = path.join(fakeRepo, "clients", "electron");
};

const setupPackaged = async (): Promise<void> => {
  const resources = await fs.mkdtemp(path.join(os.tmpdir(), "apf-res-"));
  const webRoot = path.join(resources, "cli-runtime", "web-dist");
  const appRoot = path.join(resources, "app-dist");
  await fs.mkdir(webRoot, { recursive: true });
  await fs.mkdir(appRoot, { recursive: true });
  await writeRenderer(webRoot, "web");
  await writeRenderer(appRoot, "shell");
  (process as unknown as { resourcesPath: string }).resourcesPath = resources;
  isPackaged = true;
  Object.defineProperty(process, "platform", { value: "win32" });
};

describe("registerAppProtocol", () => {
  test("the operator pass carries the session jar", async () => {
    await setupDev();
    await register();
    forwardOperator.mockResolvedValueOnce(new Response("retired"));
    const request = new Request("app://mycadet.ai/v1/assistants/a/retire/", {
      method: "DELETE",
    });
    const response = await handler!(request);
    expect(await response.text()).toBe("retired");
    // The cloud surfaces (`/_allauth`, `/accounts`, the `/v1` user paths)
    // ride the forward's own arm row — tested in local-mode. Here the
    // contract is the OPTIONS: the session jar is the rows' cookie source
    // and sink; the dialing itself is local-mode's (the ambient fetch).
    expect(forwardOperator).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        cookieJar: expect.anything(),
      }),
    );
  });

  test("an operator pass hands back to the renderer assets", async () => {
    await setupDev();
    await register();
    // The real forward's arm answers cloud paths; the mocked pass here
    // returns null for everything, so this pins the ORDER — the pass is
    // the only API surface, and what it passes reaches the asset chain's
    // SPA fallback, not an API error.
    const response = await handler!(
      new Request("app://mycadet.ai/v1/assistants/a/conversations"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<body>shell</body>");
  });

  test("unmatched requests 404", async () => {
    await setupDev();
    await register();
    const response = await handler!(
      new Request("app://mycadet.ai/assets/missing.js"),
    );
    expect(response.status).toBe(404);
  });

  test("a foreign host is forbidden before any forward", async () => {
    await setupDev();
    await register();
    const response = await handler!(
      new Request("app://evil.com/v1/assistants/a/conversations"),
    );
    expect(response.status).toBe(403);
    expect(forwardOperator).not.toHaveBeenCalled();
  });

  test("the handler serves /__config with the escaped config json", async () => {
    await setupDev();
    await register();
    const response = await handler!(
      new Request("app://mycadet.ai/assistant/__config"),
    );
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      baseUrl: "app://mycadet.ai",
      deviceId: "device-7",
      assistantName: "A<ria",
    });
    expect(body).toContain("\\u003c");
    const shell = await handler!(new Request("app://mycadet.ai/__config"));
    expect(shell.status).toBe(200);
  });

  test("app-shell index html gets the config injected", async () => {
    await setupDev();
    await register();
    const response = await handler!(new Request("app://mycadet.ai/some/route"));
    const body = await response.text();
    expect(body).toContain("<body>shell</body>");
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("content-length")).toBeNull();
  });

  test("the web-mount index html gets the config injected too", async () => {
    await setupDev();
    await register();
    const response = await handler!(
      new Request("app://mycadet.ai/web/assistant/index.html"),
    );
    const body = await response.text();
    expect(body).toContain("<body>web</body>");
  });

  test("the app shell owns /assistant documents — onboarding refreshes stay app-side", async () => {
    await setupDev();
    await register();
    const shell = await handler!(
      new Request(
        "app://mycadet.ai/assistant/onboarding/research?hosting=local",
      ),
    );
    expect(await shell.text()).toContain("<body>shell</body>");
    const root = await handler!(new Request("app://mycadet.ai/assistant"));
    expect(await root.text()).toContain("<body>shell</body>");
  });

  test("web-mount assets ride the web root verbatim", async () => {
    await setupDev();
    await register();
    // The iframe's asset URLs: the `/web` mount for frame-relative
    // requests and the vite `base` prefix (`/assistant/assets/*`) for the
    // hashed assets the document references.
    const viaBase = await handler!(
      new Request("app://mycadet.ai/assistant/assets/index.js"),
    );
    expect(await viaBase.text()).toBe("console.log(1)");
    const viaFrame = await handler!(
      new Request("app://mycadet.ai/web/assistant/assets/index.js"),
    );
    expect(await viaFrame.text()).toBe("console.log(1)");
  });

  test("packaged windows reads the web bundle inside the cli runtime", async () => {
    await setupPackaged();
    await register();
    const web = await handler!(
      new Request("app://mycadet.ai/web/assistant/index.html"),
    );
    expect(await web.text()).toContain("<body>web</body>");
    const shell = await handler!(new Request("app://mycadet.ai/some/route"));
    expect(await shell.text()).toContain("<body>shell</body>");
  });

  test("the operator forward carries the session jar as its cookie source and sink", async () => {
    await setupDev();
    await register();
    cookieGet.mockResolvedValue([
      { name: "cadet_web_access", value: "edge-token-1" },
      { name: "cadet_web_refresh", value: "edge-token-2" },
    ] as never);
    forwardOperator.mockResolvedValueOnce(new Response("ok"));
    await handler!(new Request("app://mycadet.ai/v1/conversations"));
    const [, options] = (forwardOperator.mock.calls.at(-1) ??
      []) as unknown as [
      Request,
      { cookieJar: { get: (url: string) => Promise<unknown[]>; set: unknown } },
    ];
    expect(typeof options.cookieJar.get).toBe("function");
    expect(typeof options.cookieJar.set).toBe("function");
    // `get` reads the Chromium store for the dial's own origin — the pair
    // comes back in the store's grain, exactly as the store held it.
    expect(await options.cookieJar.get("http://127.0.0.1:7830")).toEqual([
      { name: "cadet_web_access", value: "edge-token-1" },
      { name: "cadet_web_refresh", value: "edge-token-2" },
    ]);
    expect(cookieGet).toHaveBeenCalledWith({ url: "http://127.0.0.1:7830" });
  });

  test("the jar adapter writes through to the cookie store, best-effort", async () => {
    await setupDev();
    await register();
    forwardOperator.mockResolvedValueOnce(new Response("ok"));
    await handler!(new Request("app://mycadet.ai/v1/conversations"));
    const [, options] = (forwardOperator.mock.calls.at(-1) ??
      []) as unknown as [
      Request,
      { cookieJar: { set: (url: string, cookie: unknown) => Promise<void> } },
    ];
    await options.cookieJar.set("http://127.0.0.1:7833", {
      name: "cadet_web_access",
      value: "edge-token-1",
      httpOnly: true,
      path: "/",
      sameSite: "strict",
    });
    expect(cookieSet).toHaveBeenCalledWith({
      url: "http://127.0.0.1:7833",
      name: "cadet_web_access",
      value: "edge-token-1",
      httpOnly: true,
      path: "/",
      sameSite: "strict",
    });
    // A refusing store (here: the `app://` scheme Chromium rejects) never
    // fails the row — the jar's contract is best-effort custody.
    cookieSet.mockRejectedValueOnce(
      new Error("Failed to set cookie - EXCLUDE_NONCOOKIEABLE_SCHEME"),
    );
    await expect(
      options.cookieJar.set("app://mycadet.ai", { name: "x", value: "y" }),
    ).resolves.toBeUndefined();
  });
});
