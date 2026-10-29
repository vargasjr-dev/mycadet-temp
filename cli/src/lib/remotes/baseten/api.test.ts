import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  BasetenApiError,
  basetenImageRef,
  createBasetenSandbox,
  pushBasetenImage,
  resolveBasetenToken,
} from "./api.js";

const request = spyOn(globalThis, "fetch");

function calls(): Array<[string, RequestInit]> {
  return request.mock.calls as unknown as Array<[string, RequestInit]>;
}

afterEach(() => {
  request.mockReset();
  delete process.env.BASETEN_API_KEY;
  delete process.env.BASETEN_SANDBOX_TOKEN;
});

describe("resolveBasetenToken", () => {
  test("an explicit sandbox token passes through without a network call", async () => {
    process.env.BASETEN_SANDBOX_TOKEN = "short-lived-token";
    const token = await resolveBasetenToken();
    expect(token).toBe("short-lived-token");
    expect(request).not.toHaveBeenCalled();
  });

  test("the API key is exchanged at POST /v1/token", async () => {
    process.env.BASETEN_API_KEY = "b10-key";
    request.mockResolvedValueOnce(
      Response.json({ token: "minted-token", expires_at: "2026-10-29T12:00:00Z" }),
    );
    const token = await resolveBasetenToken();
    expect(token).toBe("minted-token");
    const [url, init] = calls()[0];
    expect(url).toBe("https://api.baseten.co/v1/token");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer b10-key");
    expect(JSON.parse(String(init.body))).toEqual({ scopes: ["sandboxes"] });
  });

  test("missing credentials refuse loudly instead of hitting the API", async () => {
    await expect(resolveBasetenToken()).rejects.toThrow(/BASETEN_API_KEY/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("pushBasetenImage", () => {
  test("requests an upload URL, PUTs the archive, and polls until BUILT", async () => {
    request
      .mockResolvedValueOnce(
        Response.json({
          name: "cadet",
          status: "UPLOADING",
          upload_url: "https://uploads.b10.run/cadet/source.zip",
        }, { status: 202 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ status: "BUILDING" }))
      .mockResolvedValueOnce(Response.json({ status: "BUILT" }));

    const polled: string[] = [];
    let zipped = 0;
    await pushBasetenImage("token", {
      name: "cadet",
      zip: () => {
        zipped++;
        return Promise.resolve(Buffer.from("zip"));
      },
      poll: (status) => polled.push(status),
      intervalMs: 1,
    });

    expect(zipped).toBe(1);
    expect(polled).toEqual(["BUILDING", "BUILT"]);
    const push = calls().find(([url]) => url.endsWith("/v1/sandboxes/images"));
    expect(JSON.parse(String(push?.[1].body))).toEqual({ name: "cadet" });
    const upload = calls().find(([url]) =>
      url.startsWith("https://uploads.b10.run/"),
    );
    expect(upload?.[1].method).toBe("PUT");
    const poll = calls().find(([url]) =>
      url.endsWith("/v1/sandboxes/images/cadet"),
    );
    expect(poll?.[0]).toBe("https://api.baseten.co/v1/sandboxes/images/cadet");
  });

  test("a FAILED build surfaces instead of polling forever", async () => {
    request
      .mockResolvedValueOnce(
        Response.json(
          { status: "UPLOADING", upload_url: "https://uploads.b10.run/x" },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ status: "FAILED" }));

    await expect(
      pushBasetenImage("token", {
        name: "cadet",
        zip: () => Promise.resolve(Buffer.from("zip")),
        intervalMs: 1,
      }),
    ).rejects.toThrow(/build failed/);
  });
});

describe("createBasetenSandbox", () => {
  test("posts the image ref with provider envs marked secret", async () => {
    request.mockResolvedValueOnce(
      Response.json({ name: "my-cadet", status: "DEPLOYED" }, { status: 201 }),
    );

    await createBasetenSandbox("token", {
      name: "my-cadet",
      image: basetenImageRef("cadet"),
      envs: [{ name: "ANTHROPIC_API_KEY", secret: true, value: "sk-ant-1" }],
    });

    const [url, init] = calls()[0];
    expect(url).toBe("https://api.baseten.co/v1/sandboxes/instances");
    expect(JSON.parse(String(init.body))).toEqual({
      image: "sandbox/cadet:latest",
      name: "my-cadet",
      envs: [{ name: "ANTHROPIC_API_KEY", secret: true, value: "sk-ant-1" }],
    });
  });

  test("a name is omitted from the request when not provided", async () => {
    request.mockResolvedValueOnce(
      Response.json({ name: "generated-by-server" }, { status: 201 }),
    );
    await createBasetenSandbox("token", { image: basetenImageRef("cadet") });
    expect(JSON.parse(String(calls()[0][1].body))).toEqual({
      image: "sandbox/cadet:latest",
    });
  });

  test("API errors carry Baseten's code and message", async () => {
    request.mockResolvedValueOnce(
      Response.json(
        {
          code: "ALREADY_EXISTS",
          message: "A sandbox with this name already exists.",
        },
        { status: 409 },
      ),
    );
    const err = await createBasetenSandbox("token", {
      image: basetenImageRef("cadet"),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BasetenApiError);
    expect(err.message).toMatch(/ALREADY_EXISTS/);
  });
});
