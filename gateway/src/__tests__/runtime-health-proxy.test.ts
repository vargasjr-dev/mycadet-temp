import { describe, test, expect, mock, afterEach } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { initSigningKey } from "../auth/token-service.js";

process.env.ACTOR_TOKEN_SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcde").toString("hex");
initSigningKey();

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

let healthConfig: GatewayConfig;

mock.module("../config.js", () => ({
  getConfig: () => healthConfig,
}));

const { handleRuntimeHealth } =
  await import("../http/routes/runtime-health-proxy.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    port: 7830,
    runtimeProxyRequireAuth: true,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    trustProxy: false,
    ...overrides,
  };
  return merged;
}

afterEach(() => {
  fetchMock = mock(async () => new Response());
});

describe("runtime health proxy", () => {
  test("forwards to runtime /v1/health", async () => {
    const captured: string[] = [];
    fetchMock = mock(async (input: string | URL | Request) => {
      captured.push(String(input));
      return new Response(JSON.stringify({ status: "healthy" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    healthConfig = makeConfig();
    const res = await handleRuntimeHealth(
      new Request("http://localhost:7830/v1/health"),
    );

    expect(res.status).toBe(200);
    expect(captured).toEqual(["http://localhost:7821/v1/health"]);
    expect(await res.json()).toEqual({ status: "healthy" });
  });

  test("replaces caller auth with the forwarded service identity", async () => {
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as unknown as Headers;
        return new Response("ok", { status: 200 });
      },
    );

    healthConfig = makeConfig();
    const res = await handleRuntimeHealth(
      new Request("http://localhost:7830/v1/health", {
        headers: {
          authorization: "Bearer caller-token",
          host: "localhost:7830",
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedHeaders?.get("x-cadet-subject")).toBe("svc:gateway:self");
    expect(capturedHeaders?.get("x-cadet-principal-type")).toBe("svc_gateway");
    expect(capturedHeaders?.has("host")).toBe(false);
  });

  test("returns 504 on timeout", async () => {
    fetchMock = mock(async () => {
      throw new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      );
    });

    healthConfig = makeConfig({ runtimeTimeoutMs: 100 });
    const res = await handleRuntimeHealth(
      new Request("http://localhost:7830/v1/health"),
    );

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "Gateway Timeout" });
  });
});
