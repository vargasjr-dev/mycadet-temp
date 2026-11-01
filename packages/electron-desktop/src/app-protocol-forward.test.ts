import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const protocolHandle = mock(() => undefined);
const netFetch = mock(async (url: string) => {
  const file = decodeURIComponent(new URL(url).pathname);
  const body = await fs.readFile(file, "utf8");
  return new Response(body, {
    headers: { "Content-Type": "text/html", "Content-Length": "999" },
  });
});

mock.module("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
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

const { registerAppProtocolForwarding } =
  await import("./app-protocol-forward");

const distRoots: { web: string; app: string } = {} as never;
let handler: ((r: Request) => Promise<Response>) | undefined;

const register = async (opts: { appDistRoot?: string }): Promise<void> => {
  registerAppProtocolForwarding({ webDistRoot: distRoots.web, ...opts });
  const [, h] = protocolHandle.mock.calls.at(-1) as unknown as [
    string,
    (r: Request) => Promise<Response>,
  ];
  handler = h;
};

afterEach(async () => {
  forwardOperator.mockClear();
  forwardGateway.mockClear();
  forwardCloud.mockClear();
  forwardOperator.mockResolvedValue(null);
  forwardGateway.mockResolvedValue(null);
  forwardCloud.mockResolvedValue(null);
});

const setup = async (): Promise<void> => {
  distRoots.web = await fs.mkdtemp(path.join(os.tmpdir(), "apf-web-"));
  distRoots.app = await fs.mkdtemp(path.join(os.tmpdir(), "apf-app-"));
  await fs.writeFile(
    path.join(distRoots.web, "index.html"),
    "<html><head></head><body>web</body></html>",
  );
  await fs.mkdir(path.join(distRoots.web, "assets"));
  await fs.writeFile(
    path.join(distRoots.web, "assets", "index.js"),
    "console.log(1)",
  );
  await fs.writeFile(
    path.join(distRoots.app, "index.html"),
    "<html><head></head><body>shell</body></html>",
  );
};

describe("registerAppProtocolForwarding", () => {
  test("the operator answer wins over the gateway proxy", async () => {
    await setup();
    await register({});
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
    await setup();
    await register({});
    forwardGateway.mockResolvedValueOnce(new Response("gateway"));
    const response = await handler!(
      new Request("app://mycadet.ai/v1/assistants/a/conversations"),
    );
    expect(await response.text()).toBe("gateway");
    expect(forwardCloud).not.toHaveBeenCalled();
  });

  test("the cloud forward answers what the gateway passes", async () => {
    await setup();
    await register({});
    forwardCloud.mockResolvedValueOnce(new Response("cloud"));
    const response = await handler!(
      new Request("app://mycadet.ai/v1/assistants/a/conversations"),
    );
    expect(await response.text()).toBe("cloud");
  });

  test("unmatched requests 404", async () => {
    await setup();
    await register({});
    const response = await handler!(
      new Request("app://mycadet.ai/assets/missing.js"),
    );
    expect(response.status).toBe(404);
  });

  test("a foreign host is forbidden before any forward", async () => {
    await setup();
    await register({ appDistRoot: distRoots.app });
    const response = await handler!(
      new Request("app://evil.com/v1/assistants/a/conversations"),
    );
    expect(response.status).toBe(403);
    expect(forwardOperator).not.toHaveBeenCalled();
  });

  test("the app-shell client serves /__config with the escaped config json", async () => {
    await setup();
    await register({ appDistRoot: distRoots.app });
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
    await setup();
    await register({ appDistRoot: distRoots.app });
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

  test("web-mount assets ride the web root verbatim", async () => {
    await setup();
    await register({ appDistRoot: distRoots.app });
    const response = await handler!(
      new Request("app://mycadet.ai/assistant/assets/index.js"),
    );
    expect(await response.text()).toBe("console.log(1)");
  });

  test("web-bundle clients never inject config", async () => {
    await setup();
    await register({});
    const response = await handler!(
      new Request("app://mycadet.ai/assistant/index.html"),
    );
    const body = await response.text();
    expect(body).toContain("<body>web</body>");
    expect(body).not.toContain("__CADET_CONFIG__");
    expect(response.status).toBe(200);
  });
});
