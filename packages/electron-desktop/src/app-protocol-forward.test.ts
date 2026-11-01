import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let isPackaged = false;
let appPath = process.cwd();

const protocolHandle = mock(() => undefined);
const netFetch = mock(async (url: string) => {
  const file = decodeURIComponent(new URL(url).pathname);
  const body = await fs.readFile(file, "utf8");
  return new Response(body, {
    headers: { "Content-Type": "text/html", "Content-Length": "999" },
  });
});

mock.module("electron", () => ({
  app: {
    get isPackaged() {
      return isPackaged;
    },
    getAppPath: () => appPath,
  },
  net: { fetch: netFetch },
  protocol: { handle: protocolHandle },
}));

const forwardOperator = mock(async (): Promise<Response | null> => null);
const forwardGateway = mock(async (): Promise<Response | null> => null);
const forwardCloud = mock(async (): Promise<Response | null> => null);

mock.module("./operator-forward", () => ({
  forwardOperatorRequest: forwardOperator,
}));
mock.module("./gateway-forward", () => ({
  forwardGatewayRequest: forwardGateway,
}));
mock.module("./cloud-forward", () => ({
  forwardCloudRequest: forwardCloud,
}));
mock.module("./device-id", () => ({ getDeviceId: () => "device-7" }));
mock.module("./about", () => ({
  getVersionInfo: () => ({ version: "9.9.9" }),
}));
mock.module("./app-logger", () => ({
  default: { error: mock(), warning: mock(), info: mock() },
}));
mock.module("@mycadet/local-mode", () => ({
  resolveLocalConfigFromEnv: () => ({ cloudUrl: "https://cloud.example.com" }),
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
  forwardGateway.mockClear();
  forwardCloud.mockClear();
  forwardOperator.mockResolvedValue(null);
  forwardGateway.mockResolvedValue(null);
  forwardCloud.mockResolvedValue(null);
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
  test("the operator answer wins over the gateway proxy", async () => {
    await setupDev();
    await register();
    forwardOperator.mockResolvedValueOnce(new Response("retired"));
    const response = await handler!(
      new Request("app://mycadet.ai/v1/assistants/a/retire/", {
        method: "DELETE",
      }),
    );
    expect(await response.text()).toBe("retired");
    expect(forwardGateway).not.toHaveBeenCalled();
    expect(forwardCloud).not.toHaveBeenCalled();
  });

  test("the gateway proxy wins over the cloud forward", async () => {
    await setupDev();
    await register();
    forwardGateway.mockResolvedValueOnce(new Response("gateway"));
    const response = await handler!(
      new Request("app://mycadet.ai/v1/assistants/a/conversations"),
    );
    expect(await response.text()).toBe("gateway");
    expect(forwardCloud).not.toHaveBeenCalled();
  });

  test("the cloud forward answers what the gateway passes", async () => {
    await setupDev();
    await register();
    forwardCloud.mockResolvedValueOnce(new Response("cloud"));
    const response = await handler!(
      new Request("app://mycadet.ai/v1/assistants/a/conversations"),
    );
    expect(await response.text()).toBe("cloud");
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
      version: "9.9.9",
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
    expect(body).toContain(
      'window.__CADET_CONFIG__={"baseUrl":"app://mycadet.ai"',
    );
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
      new Request("app://mycadet.ai/assistant/index.html"),
    );
    const body = await response.text();
    expect(body).toContain(
      'window.__CADET_CONFIG__={"baseUrl":"app://mycadet.ai"',
    );
    expect(body).toContain("<body>web</body>");
  });

  test("web-mount assets ride the web root verbatim", async () => {
    await setupDev();
    await register();
    const response = await handler!(
      new Request("app://mycadet.ai/assistant/assets/index.js"),
    );
    expect(await response.text()).toBe("console.log(1)");
  });

  test("packaged windows reads the web bundle inside the cli runtime", async () => {
    await setupPackaged();
    await register();
    const web = await handler!(
      new Request("app://mycadet.ai/assistant/index.html"),
    );
    expect(await web.text()).toContain("<body>web</body>");
    const shell = await handler!(new Request("app://mycadet.ai/some/route"));
    expect(await shell.text()).toContain("<body>shell</body>");
  });
});
