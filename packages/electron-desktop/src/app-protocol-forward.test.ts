import { describe, expect, mock, test } from "bun:test";

const protocolHandle = mock(() => undefined);

mock.module("electron", () => ({
  net: { fetch: mock(async () => new Response()) },
  protocol: { handle: protocolHandle },
}));

const forwardOperator = mock(
  async (): Promise<Response | null> => null,
);
const forwardGateway = mock(
  async (): Promise<Response | null> => null,
);
const forwardCloud = mock(
  async (): Promise<Response | null> => null,
);

mock.module("./operator-forward", () => ({
  forwardOperatorRequest: forwardOperator,
}));
mock.module("./gateway-forward", () => ({
  forwardGatewayRequest: forwardGateway,
}));
mock.module("./cloud-forward", () => ({
  forwardCloudRequest: forwardCloud,
}));

const { registerAppProtocolForwarding } = await import(
  "./app-protocol-forward"
);

const OPTIONS = {
  appProtocol: "app",
  appHost: "mycadet.ai",
  rendererRoot: "/nonexistent-renderer-root",
  cloudUrl: "https://cloud.example.com",
  resolveAllowedOrigin: () => ({ protocol: "app:", host: "mycadet.ai" }),
  log: { error: mock(() => undefined), warning: mock(() => undefined) },
};

const handlerFor = async (): Promise<(r: Request) => Promise<Response>> => {
  registerAppProtocolForwarding(OPTIONS);
  const [scheme, handler] = protocolHandle.mock.calls.at(-1) as unknown as [
    string,
    (r: Request) => Promise<Response>,
  ];
  expect(scheme).toBe("app");
  return handler;
};

describe("registerAppProtocolForwarding", () => {
  test("the operator answer wins over the gateway proxy", async () => {
    const handler = await handlerFor();
    forwardOperator.mockResolvedValueOnce(new Response("retired"));
    const response = await handler(
      new Request("app://mycadet.ai/v1/assistants/a/retire/", {
        method: "DELETE",
      }),
    );
    expect(await response.text()).toBe("retired");
    expect(forwardGateway).not.toHaveBeenCalled();
    expect(forwardCloud).not.toHaveBeenCalled();
  });

  test("the gateway proxy wins over the cloud forward", async () => {
    const handler = await handlerFor();
    forwardOperator.mockResolvedValueOnce(null);
    forwardGateway.mockResolvedValueOnce(new Response("gateway"));
    const response = await handler(
      new Request("app://mycadet.ai/v1/assistants/a/conversations"),
    );
    expect(await response.text()).toBe("gateway");
    expect(forwardCloud).not.toHaveBeenCalled();
  });

  test("the cloud forward answers what the gateway passes", async () => {
    const handler = await handlerFor();
    forwardOperator.mockResolvedValueOnce(null);
    forwardGateway.mockResolvedValueOnce(null);
    forwardCloud.mockResolvedValueOnce(new Response("cloud"));
    const response = await handler(
      new Request("app://mycadet.ai/v1/assistants/a/conversations"),
    );
    expect(await response.text()).toBe("cloud");
  });

  test("unmatched requests 404 (no renderer on disk)", async () => {
    const handler = await handlerFor();
    forwardOperator.mockResolvedValue(null);
    forwardGateway.mockResolvedValue(null);
    forwardCloud.mockResolvedValue(null);
    const response = await handler(
      new Request("app://mycadet.ai/assets/index.js"),
    );
    expect(response.status).toBe(404);
  });
});
