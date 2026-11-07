import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { IncomingHttpHeaders } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { matchOperatorRequest } from "../operations/routes";

// The proxy row forwards through globalThis.fetch; the real one stays
// snapshotted for the per-test restore (bun runs every test file in one
// process with a shared loader).
const realFetch = globalThis.fetch;

let tmpDir = "";
let lockfilePath = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-proxy-op-"));
  lockfilePath = path.join(tmpDir, "cadet", "lockfile.json");
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const seedLocalEntry = () => {
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
  fs.writeFileSync(
    lockfilePath,
    JSON.stringify({
      assistants: [
        {
          assistantId: "asst-local",
          cloud: "local",
          port: 7830,
          instanceDir: tmpDir,
        },
      ],
      activeAssistant: null,
    }),
  );
};

type GatewayCall = {
  url: string;
  method: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
};

const stubGatewayFetch = (
  respond: (call: GatewayCall) => Response | Promise<Response> = () =>
    new Response("gateway says hi"),
): GatewayCall[] => {
  const calls: GatewayCall[] = [];
  globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
    const request =
      input instanceof Request
        ? input
        : new Request(input as string, init as RequestInit | undefined);
    const call: GatewayCall = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body as ReadableStream<Uint8Array> | null,
    };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return calls;
};

/** The proxy row's run, addressed to the seeded entry's scoped surface. */
const runProxy = async (
  tail: string,
  init?: {
    method?: string;
    headers?: Headers | IncomingHttpHeaders;
    body?: ReadableStream | null;
    peer?: string | null;
  },
): Promise<Response> => {
  const path = `/v1/assistants/asst-local/${tail}`;
  const match = matchOperatorRequest(path, init?.method ?? "GET");
  expect(match?.route.method).toBe("ALL");
  const response = await match!.route.run({
    assistantId: "asst-local",
    method: init?.method ?? "GET",
    path,
    peer: init?.peer,
    headers: init?.headers,
    body: init?.body ?? null,
  });
  expect(response).not.toBeNull();
  return response!;
};

describe("the operator route table — the proxy catch-all", () => {
  test("the scoped tail proxies verbatim, stamping the rightmost X-Forwarded-For entry", async () => {
    seedLocalEntry();
    const calls = stubGatewayFetch();
    await runProxy("things", {
      headers: new Headers({ "x-forwarded-for": "203.0.113.9, 198.51.100.7" }),
    });
    expect(new URL(calls[0]!.url).pathname).toBe(
      "/v1/assistants/asst-local/things",
    );
    expect(calls[0]!.headers.get("x-cadet-client-ip")).toBe("198.51.100.7");
  });

  test("the client-ip stamp falls back to the raw peer, then the loopback default", async () => {
    seedLocalEntry();
    const calls = stubGatewayFetch();
    await runProxy("things", { peer: "198.51.100.7" });
    expect(calls[0]!.headers.get("x-cadet-client-ip")).toBe("198.51.100.7");
    await runProxy("things");
    expect(calls[1]!.headers.get("x-cadet-client-ip")).toBe("127.0.0.1");
  });

  test("the connect record's raw headers normalize: lists comma-join, undefined drops", async () => {
    seedLocalEntry();
    const calls = stubGatewayFetch();
    await runProxy("things", {
      headers: {
        "x-forwarded-for": ["203.0.113.9", "198.51.100.7"],
        "accept-language": undefined,
        authorization: "Bearer device-token",
      } as IncomingHttpHeaders,
    });
    const headers = calls[0]!.headers;
    expect(headers.get("x-cadet-client-ip")).toBe("198.51.100.7");
    expect(headers.get("accept-language")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer device-token");
  });

  test("strips the host and hop-by-hop headers from the upstream request", async () => {
    seedLocalEntry();
    const calls = stubGatewayFetch();
    await runProxy("things", {
      headers: new Headers({
        host: "camping.ngrok-free.dev",
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        authorization: "Bearer device-token",
      }),
    });
    const headers = calls[0]!.headers;
    expect(headers.get("host")).toBeNull();
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("keep-alive")).toBeNull();
    // The caller's own headers ride as-is.
    expect(headers.get("authorization")).toBe("Bearer device-token");
  });

  test("drops the length and encoding headers a decoded proxied response outgrows", async () => {
    seedLocalEntry();
    stubGatewayFetch(
      () =>
        new Response("gateway body", {
          status: 201,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "999",
            "Content-Encoding": "gzip",
          },
        }),
    );
    const response = await runProxy("things");
    expect(response.status).toBe(201);
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe("gateway body");
  });

  test("streams a POST body to the gateway (duplex half)", async () => {
    seedLocalEntry();
    const calls = stubGatewayFetch(() => new Response(null, { status: 204 }));
    const response = await runProxy("messages", {
      method: "POST",
      body: new Response("the message body").body,
      headers: new Headers({ "content-type": "text/plain" }),
    });
    expect(response.status).toBe(204);
    expect(calls[0]!.method).toBe("POST");
    expect(await new Response(calls[0]!.body).text()).toBe("the message body");
  });

  test("redirects pass through un-followed (the caller owns its own 3xx)", async () => {
    seedLocalEntry();
    stubGatewayFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://gw.example.com/next" },
        }),
    );
    const response = await runProxy("things");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://gw.example.com/next",
    );
  });

  test("a proxied response is never re-compressed", async () => {
    seedLocalEntry();
    stubGatewayFetch(
      () =>
        new Response("<html>gateway html</html>", {
          headers: { "content-type": "text/html" },
        }),
    );
    const response = await runProxy("page", {
      headers: new Headers({ "accept-encoding": "gzip" }),
    });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe("<html>gateway html</html>");
  });

  test("an unknown id still passes — the pre-existing chain answers instead", async () => {
    seedLocalEntry();
    const calls = stubGatewayFetch();
    const match = matchOperatorRequest(
      "/v1/assistants/asst-ghost/things",
      "GET",
    );
    const response = await match!.route.run({
      assistantId: "asst-ghost",
      method: "GET",
      path: "/v1/assistants/asst-ghost/things",
    });
    expect(response).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("the proxy catch-all — the CADET_PROXY_TRANSPORT=ipc toggle", () => {
  const savedTransport = process.env.CADET_PROXY_TRANSPORT;

  afterEach(() => {
    if (savedTransport === undefined) {
      delete process.env.CADET_PROXY_TRANSPORT;
    } else {
      process.env.CADET_PROXY_TRANSPORT = savedTransport;
    }
  });

  test("the toggle stamps x-cadet-proxy-server: ipc on the forward", async () => {
    seedLocalEntry();
    process.env.CADET_PROXY_TRANSPORT = "ipc";
    const calls = stubGatewayFetch();
    await runProxy("things");
    expect(calls[0]!.headers.get("x-cadet-proxy-server")).toBe("ipc");
  });

  test("unset (or http) forwards without the header", async () => {
    seedLocalEntry();
    delete process.env.CADET_PROXY_TRANSPORT;
    const calls = stubGatewayFetch();
    await runProxy("things");
    expect(calls[0]!.headers.get("x-cadet-proxy-server")).toBeNull();

    process.env.CADET_PROXY_TRANSPORT = "http";
    await runProxy("things");
    expect(calls[1]!.headers.get("x-cadet-proxy-server")).toBeNull();
  });

  test("the toggle overrides whatever the client supplied", async () => {
    seedLocalEntry();
    process.env.CADET_PROXY_TRANSPORT = "ipc";
    const calls = stubGatewayFetch();
    await runProxy("things", {
      headers: new Headers({ "x-cadet-proxy-server": "http" }),
    });
    expect(calls[0]!.headers.get("x-cadet-proxy-server")).toBe("ipc");
  });
});
