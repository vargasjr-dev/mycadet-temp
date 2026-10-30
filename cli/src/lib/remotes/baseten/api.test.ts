import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as basetenCli from "./baseten-cli.js";
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

/** The HTTP arms' spies: no installed CLI, and an API key whose exchange is mocked. */
function httpArm() {
  process.env.BASETEN_API_KEY = "b10-key";
  request.mockResolvedValueOnce(
    Response.json({ token: "short-lived-token" }),
  );
  return [
    spyOn(basetenCli, "resolveBasetenCli").mockResolvedValue(null),
    spyOn(basetenCli, "runBasetenCli").mockResolvedValue(undefined),
  ];
}

/** The CLI-arm spies: an installed CLI, and a runner that never spawns. */
function cliArm() {
  return [
    spyOn(basetenCli, "resolveBasetenCli").mockResolvedValue("baseten"),
    spyOn(basetenCli, "runBasetenCli").mockResolvedValue(undefined),
  ];
}

afterEach(() => {
  request.mockReset();
  delete process.env.BASETEN_API_KEY;
});

describe("resolveBasetenToken", () => {
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
  test("an installed baseten CLI takes the push and no token is needed", async () => {
    const [cli, run] = cliArm();

    await pushBasetenImage({
      name: "cadet",
      dir: "/tmp/staged",
      zip: () => Promise.resolve(Buffer.from("zip")),
    });

    expect(run).toHaveBeenCalledWith([
      "sandbox",
      "image",
      "push",
      "--name",
      "cadet",
      "--dir",
      "/tmp/staged",
      "--wait",
    ]);
    expect(request).not.toHaveBeenCalled();
    cli.mockRestore();
    run.mockRestore();
  });

  test("without a CLI it requests an upload URL, PUTs the archive, and polls until BUILT", async () => {
    const [cli, run] = httpArm();
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
    await pushBasetenImage({
      name: "cadet",
      dir: "/tmp/staged",
      zip: () => {
        zipped++;
        return Promise.resolve(Buffer.from("zip"));
      },
      poll: (status) => polled.push(status),
      intervalMs: 1,
    });

    expect(run).not.toHaveBeenCalled();
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
    cli.mockRestore();
    run.mockRestore();
  });

  test("without a CLI a FAILED build surfaces instead of polling forever", async () => {
    const [cli, run] = httpArm();
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
      pushBasetenImage({
        name: "cadet",
        dir: "/tmp/staged",
        zip: () => Promise.resolve(Buffer.from("zip")),
        intervalMs: 1,
      }),
    ).rejects.toThrow(/build failed/);
    cli.mockRestore();
    run.mockRestore();
  });
});

describe("createBasetenSandbox", () => {
  test("an installed CLI creates through argv with env pairs and echoes the name", async () => {
    const [cli, run] = cliArm();

    const created = await createBasetenSandbox({
      name: "my-cadet",
      image: basetenImageRef("cadet"),
      envs: [{ name: "ANTHROPIC_API_KEY", secret: true, value: "sk-ant-1" }],
    });

    expect(run).toHaveBeenCalledWith([
      "sandbox",
      "create",
      "--image",
      "sandbox/cadet:latest",
      "--name",
      "my-cadet",
      "--env",
      "ANTHROPIC_API_KEY=sk-ant-1",
    ]);
    expect(created).toEqual({ name: "my-cadet" });
    expect(request).not.toHaveBeenCalled();
    cli.mockRestore();
    run.mockRestore();
  });

  test("over HTTP it posts the image ref with provider envs marked secret", async () => {
    const [cli, run] = httpArm();
    request.mockResolvedValueOnce(
      Response.json({ name: "my-cadet", status: "DEPLOYED" }, { status: 201 }),
    );

    await createBasetenSandbox({
      name: "my-cadet",
      image: basetenImageRef("cadet"),
      envs: [{ name: "ANTHROPIC_API_KEY", secret: true, value: "sk-ant-1" }],
    });

    const instances = calls().find(([url]) =>
      url.endsWith("/v1/sandboxes/instances"),
    );
    expect(instances?.[0]).toBe("https://api.baseten.co/v1/sandboxes/instances");
    expect(JSON.parse(String(instances?.[1].body))).toEqual({
      image: "sandbox/cadet:latest",
      name: "my-cadet",
      envs: [{ name: "ANTHROPIC_API_KEY", secret: true, value: "sk-ant-1" }],
    });
    cli.mockRestore();
    run.mockRestore();
  });

  test("over HTTP a name is omitted from the request when not provided", async () => {
    const [cli, run] = httpArm();
    request.mockResolvedValueOnce(
      Response.json({ name: "generated-by-server" }, { status: 201 }),
    );
    await createBasetenSandbox({ image: basetenImageRef("cadet") });
    const instances = calls().find(([url]) =>
      url.endsWith("/v1/sandboxes/instances"),
    );
    expect(JSON.parse(String(instances?.[1].body))).toEqual({
      image: "sandbox/cadet:latest",
    });
    cli.mockRestore();
    run.mockRestore();
  });

  test("over HTTP API errors carry Baseten's code and message", async () => {
    const [cli, run] = httpArm();
    request.mockResolvedValueOnce(
      Response.json(
        {
          code: "ALREADY_EXISTS",
          message: "A sandbox with this name already exists.",
        },
        { status: 409 },
      ),
    );
    const err = await createBasetenSandbox({
      image: basetenImageRef("cadet"),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BasetenApiError);
    expect(err.message).toMatch(/ALREADY_EXISTS/);
    cli.mockRestore();
    run.mockRestore();
  });
});
