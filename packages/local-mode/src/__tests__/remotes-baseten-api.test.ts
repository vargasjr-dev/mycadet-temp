import { beforeEach, afterEach, describe, expect, spyOn, test } from "bun:test";

import * as basetenCli from "../remotes/baseten/baseten-cli.js";
import {
  BASETEN_GATEWAY_PREVIEW,
  BasetenApiError,
  basetenImageRef,
  createBasetenPreviewToken,
  createBasetenSandbox,
  ensureBasetenGatewayPreview,
  pushBasetenImage,
  resolveBasetenToken,
} from "../remotes/baseten/api.js";

// The fetch spy lives per test, not per file: the readiness suites in this
// package also spy globalThis.fetch, and a file-lifetime spy here breaks
// theirs when bun batches the files into one process.
let request: ReturnType<typeof spyOn>;
let capture: ReturnType<typeof spyOn>;

beforeEach(() => {
  request = spyOn(globalThis, "fetch");
});

function calls(): Array<[string, RequestInit]> {
  return request.mock.calls as unknown as Array<[string, RequestInit]>;
}

/** The HTTP arms' spies: no installed CLI, and an API key whose exchange is mocked. */
function httpArm() {
  process.env.BASETEN_API_KEY = "b10-key";
  request.mockResolvedValueOnce(Response.json({ token: "short-lived-token" }));
  return [
    spyOn(basetenCli, "resolveBasetenCli").mockResolvedValue(null),
    spyOn(basetenCli, "runBasetenCliCaptured").mockResolvedValue(""),
  ];
}

/** The CLI-arm spies: an installed CLI, a captured runner whose output is
 * (by default) empty — the arms narrate themselves — and a describe that
 * reports the sandbox's URL (pre-release `describe --jq` prints it
 * jq-quoted). */
function cliArm(
  describeUrl = '"https://sbx-my-cadet-abc123.us-pdx-1.b10.co"',
  createOutput = "",
) {
  capture = spyOn(basetenCli, "captureBasetenCli").mockResolvedValue(describeUrl);
  return [
    spyOn(basetenCli, "resolveBasetenCli").mockResolvedValue("baseten"),
    spyOn(basetenCli, "runBasetenCliCaptured").mockResolvedValue(createOutput),
    capture,
  ];
}

afterEach(() => {
  request.mockRestore();
  delete process.env.BASETEN_API_KEY;
  delete process.env.BASETEN_TEAM_ID;
});

describe("resolveBasetenToken", () => {
  test("the API key is exchanged at POST /v1/token", async () => {
    process.env.BASETEN_API_KEY = "b10-key";
    request.mockResolvedValueOnce(
      Response.json({
        token: "minted-token",
        expires_at: "2026-10-29T12:00:00Z",
      }),
    );
    const token = await resolveBasetenToken();
    expect(token).toBe("minted-token");
    const [url, init] = calls()[0];
    expect(url).toBe("https://api.baseten.co/v1/token");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer b10-key",
    );
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
      zip: () => Buffer.from("zip"),
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
        Response.json(
          {
            name: "cadet",
            status: "UPLOADING",
            upload_url: "https://uploads.b10.run/cadet/source.zip",
          },
          { status: 202 },
        ),
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
        return Buffer.from("zip");
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
        zip: () => Buffer.from("zip"),
        intervalMs: 1,
      }),
    ).rejects.toThrow(/build failed/);
    cli.mockRestore();
    run.mockRestore();
  });
});

describe("the gateway preview", () => {
  test("the mint rides the API with create_if_not_exists — private by default", async () => {
    const [cli] = httpArm();
    request.mockResolvedValueOnce(
      Response.json({
        name: BASETEN_GATEWAY_PREVIEW,
        port: 7830,
        url: "https://tkm1.preview.b10.co",
      }),
    );

    const { url } = await ensureBasetenGatewayPreview("sbx-my-cadet", 7830);

    expect(url).toBe("https://tkm1.preview.b10.co");
    const [tokenCall, previewCall] = calls();
    expect(tokenCall[0]).toBe("https://api.baseten.co/v1/token");
    expect(previewCall[0]).toBe(
      "https://api.baseten.co/v1/sandboxes/instances/sbx-my-cadet/previews",
    );
    expect(JSON.parse(String(previewCall[1]?.body))).toEqual({
      name: "gateway",
      port: 7830,
      create_if_not_exists: true,
    });
    cli.mockRestore();
  });

  test("the preview token mint returns the header/cookie credential", async () => {
    const [cli] = httpArm();
    request.mockResolvedValueOnce(
      Response.json({
        name: "tok123",
        token: "prev-tok-1",
        expires_at: "2026-12-05T00:00:00Z",
      }),
    );

    const token = await createBasetenPreviewToken(
      "sbx-my-cadet",
      "gateway",
      new Date("2026-12-05T00:00:00Z"),
    );

    expect(token).toBe("prev-tok-1");
    const [, previewTokenCall] = calls();
    expect(previewTokenCall[0]).toBe(
      "https://api.baseten.co/v1/sandboxes/instances/sbx-my-cadet/previews/gateway/tokens",
    );
    // Date's ISO output carries milliseconds — the wire shape matters, the
    // exact precision does not.
    expect(JSON.parse(String(previewTokenCall[1]?.body))).toEqual({
      expires_at: "2026-12-05T00:00:00.000Z",
      create_if_not_exists: true,
    });
    cli.mockRestore();
  });
});

describe("createBasetenSandbox", () => {
  test("an installed CLI creates through argv with env pairs and echoes the name", async () => {
    const [cli, run, capture] = cliArm();

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
    // The CLI create has no ports flag — the preview covers reachability
    // for CLI-arm sandboxes; only the API arm declares create-time ports.
    expect(capture).toHaveBeenCalledWith([
      "sandbox",
      "describe",
      "--name",
      "my-cadet",
      "--jq",
      ".url",
    ]);
    // The CLI arm reads the sandbox's URL back off describe so the hatch can
    // record it in the lockfile.
    expect(created).toEqual({
      name: "my-cadet",
      url: "https://sbx-my-cadet-abc123.us-pdx-1.b10.co",
    });
    expect(request).not.toHaveBeenCalled();
    cli.mockRestore();
    run.mockRestore();
    capture.mockRestore();
  });

  test("secret envs ride --env while plain config rides --plain-env", async () => {
    const [cli, run, capture] = cliArm();

    await createBasetenSandbox({
      name: "my-cadet",
      image: basetenImageRef("cadet"),
      envs: [
        { name: "GATEWAY_PORT", value: "7830", secret: false },
        { name: "ANTHROPIC_API_KEY", secret: true, value: "sk-ant-1" },
      ],
    });

    const argv = run.mock.calls[0]![0] as string[];
    expect(argv).toContain("--plain-env");
    expect(argv).toContain("GATEWAY_PORT=7830");
    expect(argv).toContain("--env");
    expect(argv).toContain("ANTHROPIC_API_KEY=sk-ant-1");
    cli.mockRestore();
    run.mockRestore();
    capture.mockRestore();
  });

  test("a server-named sandbox parses its name and URL off the create output", async () => {
    // With no requested name the server picks one — and the URL only ever
    // appears in the create output (describe needs the name first). This is
    // the hatch's default path: `cadet-dev hatch --remote baseten` passes no
    // name, and the URL must still land in the lockfile.
    const [cli, run, capture] = cliArm(
      '"https://sbx-never-describe.b10.co"',
      [
        "Name:         063543e1-a27e-4496-8ecd-f5db52ad5238",
        "Status:       DEPLOYED",
        "URL:          https://sbx-063543e1-a27e-4496-8ecd-f5db52ad5238-i6914d.us-pdx-1.b10.co",
        "Image:        sandbox/cadet:latest",
        "Memory:       4096 MB",
        "Region:       us-pdx-1",
        "Created:      2026-11-05T16:42:29Z",
        "Expires in:   167h59m51s",
      ].join("\n"),
    );

    const created = await createBasetenSandbox({
      image: basetenImageRef("cadet"),
    });

    expect(created).toEqual({
      name: "063543e1-a27e-4496-8ecd-f5db52ad5238",
      url: "https://sbx-063543e1-a27e-4496-8ecd-f5db52ad5238-i6914d.us-pdx-1.b10.co",
    });
    // No name was requested, so there is nothing to describe — the output
    // carried everything.
    expect(capture).not.toHaveBeenCalled();
    cli.mockRestore();
    run.mockRestore();
    capture.mockRestore();
  });

  test("a describe miss still creates, just without a URL to record", async () => {
    const [cli, run, capture] = cliArm("");

    const created = await createBasetenSandbox({
      name: "my-cadet",
      image: basetenImageRef("cadet"),
    });

    expect(created).toEqual({ name: "my-cadet" });
    cli.mockRestore();
    run.mockRestore();
    capture.mockRestore();
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
    expect(instances?.[0]).toBe(
      "https://api.baseten.co/v1/sandboxes/instances",
    );
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

  test("BASETEN_TEAM_ID rides --team on the CLI arm and X-Team-Id over HTTP", async () => {
    process.env.BASETEN_TEAM_ID = "team-abc123";
    const [cli, run] = cliArm();
    await createBasetenSandbox({
      name: "my-cadet",
      image: basetenImageRef("cadet"),
    });
    expect(run).toHaveBeenCalledWith([
      "sandbox",
      "create",
      "--image",
      "sandbox/cadet:latest",
      "--name",
      "my-cadet",
      "--team",
      "team-abc123",
    ]);
    // The describe that resolves the sandbox's URL selects the team too —
    // a multi-team caller cannot describe outside their selected team.
    expect(capture).toHaveBeenCalledWith([
      "sandbox",
      "describe",
      "--name",
      "my-cadet",
      "--team",
      "team-abc123",
      "--jq",
      ".url",
    ]);
    cli.mockRestore();
    run.mockRestore();

    const [httpCli, httpRun] = httpArm();
    request.mockResolvedValueOnce(
      Response.json({ name: "my-cadet", status: "DEPLOYED" }, { status: 201 }),
    );
    await createBasetenSandbox({
      name: "my-cadet",
      image: basetenImageRef("cadet"),
    });
    const instances = calls().find(([url]) =>
      url.endsWith("/v1/sandboxes/instances"),
    );
    expect(new Headers(instances?.[1].headers).get("X-Team-Id")).toBe(
      "team-abc123",
    );
    httpCli.mockRestore();
    httpRun.mockRestore();
  });

  test("BASETEN_TEAM_ID rides the image push on both arms", async () => {
    process.env.BASETEN_TEAM_ID = "team-abc123";
    const [cli, run] = cliArm();
    await pushBasetenImage({
      name: "cadet",
      dir: "/tmp/staged",
      zip: () => Buffer.from("zip"),
    });
    expect(run).toHaveBeenCalledWith([
      "sandbox",
      "image",
      "push",
      "--name",
      "cadet",
      "--dir",
      "/tmp/staged",
      "--team",
      "team-abc123",
      "--wait",
    ]);
    cli.mockRestore();
    run.mockRestore();

    const [httpCli, httpRun] = httpArm();
    request
      .mockResolvedValueOnce(
        Response.json(
          {
            name: "cadet",
            status: "UPLOADING",
            upload_url: "https://uploads.b10.run/cadet/source.zip",
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ status: "BUILT" }));
    await pushBasetenImage({
      name: "cadet",
      dir: "/tmp/staged",
      zip: () => Buffer.from("zip"),
      intervalMs: 1,
    });
    const pushes = calls().filter(([url]) =>
      url.endsWith("/v1/sandboxes/images"),
    );
    expect(new Headers(pushes[0][1].headers).get("X-Team-Id")).toBe(
      "team-abc123",
    );
    const status = calls().find(([url]) =>
      url.endsWith("/v1/sandboxes/images/cadet"),
    );
    expect(new Headers(status?.[1].headers).get("X-Team-Id")).toBe(
      "team-abc123",
    );
    httpCli.mockRestore();
    httpRun.mockRestore();
  });

  test("without BASETEN_TEAM_ID no team header is sent", async () => {
    const [cli, run] = httpArm();
    request.mockResolvedValueOnce(
      Response.json({ name: "my-cadet", status: "DEPLOYED" }, { status: 201 }),
    );
    await createBasetenSandbox({
      name: "my-cadet",
      image: basetenImageRef("cadet"),
    });
    const instances = calls().find(([url]) =>
      url.endsWith("/v1/sandboxes/instances"),
    );
    expect(new Headers(instances?.[1].headers).get("X-Team-Id")).toBe(null);
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
