import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fetchMock = mock<
  (url: string | URL | Request, init?: RequestInit) => Promise<Response>
>(async () => new Response("{}"));

let forwardOperatorRequest: (request: Request) => Promise<Response | null>;

/**
 * Dispatches through the real dispatcher — the rows are its internals, so
 * the tests speak the mount's API, not the match/run seam.
 */
const dispatch = (path: string, method = "GET"): Promise<Response | null> =>
  forwardOperatorRequest(
    new Request(`http://operator.test${path}`, { method }),
  );

describe("the releases row — GET /v1/releases", () => {
  beforeEach(async () => {
    ({ forwardOperatorRequest } = await import("../operations/routes"));
    // The lockfile read resolves nothing here — the row is entry-free.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-releases-op-"));
    process.env.XDG_CONFIG_HOME = tmpDir;
    delete process.env.CADET_CLOUD_TOKEN;
    process.env.CADET_CLOUD_URL = "https://test-cloud.mycadet.ai";
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response("{}"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.CADET_CLOUD_URL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("dials the cloud's catalog on the operator's bearer token and passes the answer through verbatim", async () => {
    process.env.CADET_CLOUD_TOKEN = "operator-token";
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ releases: ["1.2.3"] }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        }),
    );

    const response = await dispatch("/v1/releases/");
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ releases: ["1.2.3"] });
    expect(response?.headers.get("cache-control")).toBe("no-store");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://test-cloud.mycadet.ai/v1/releases/");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer operator-token",
    );
  });

  test("a missing cloud token answers 401 without dialing", async () => {
    const response = await dispatch("/v1/releases/");
    expect(response?.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an unreachable cloud answers 502 with the dial's message", async () => {
    process.env.CADET_CLOUD_TOKEN = "operator-token";
    fetchMock.mockImplementation(async () => {
      throw new Error("connection refused");
    });

    const response = await dispatch("/v1/releases/");
    expect(response?.status).toBe(502);
    expect(await response?.json()).toEqual({ detail: "connection refused" });
  });
});

let tmpDir: string;
