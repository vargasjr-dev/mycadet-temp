import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { saveBasetenSandboxToken } from "../guardian-token.js";
import * as basetenCli from "../remotes/baseten/baseten-cli.js";
import {
  basetenExecArgs,
  cadetExecCommand,
  consumeBasetenExecEvent,
  execBasetenSandbox,
  execCommandLine,
  type BasetenExecEvent,
} from "../remotes/baseten/exec.js";

/** The exec tests write a real token file — pin the config dir to a fresh
 * tmpdir so neither the suite nor the machine's own state leaks. */
let home: string;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "baseten-exec-"));
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
    savedEnv.set(key, process.env[key]);
    process.env[key] = path.join(home, key.toLowerCase());
  }
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("execCommandLine", () => {
  test("plain argv joins as one shell line", () => {
    expect(execCommandLine(["ls", "-la", "/tmp"])).toBe("ls -la /tmp");
  });

  test("each argument stays one argument — spaces and quotes are the sandbox shell's to interpret", () => {
    expect(execCommandLine(["echo", "a b"])).toBe("echo 'a b'");
    expect(execCommandLine(["sh", "-c", "ps aux | grep cadet"])).toBe(
      "sh -c 'ps aux | grep cadet'",
    );
    expect(execCommandLine(["echo", "it's"])).toBe("echo 'it'\\''s'");
  });
});

describe("cadetExecCommand", () => {
  test("the command wraps in the sandbox's own cadet exec", () => {
    expect(cadetExecCommand(["cadet", "ps"])).toEqual([
      "cadet",
      "exec",
      "--",
      "cadet",
      "ps",
    ]);
  });

  test("a non-assistant service rides --service — the sandbox's cadet resolves its pwd", () => {
    expect(cadetExecCommand(["cat", "gateway.log"], "gateway")).toEqual([
      "cadet",
      "exec",
      "--service",
      "gateway",
      "--",
      "cat",
      "gateway.log",
    ]);
    expect(cadetExecCommand(["ls"], "credential-executor")[2]).toBe(
      "--service",
    );
    expect(cadetExecCommand(["ls"], "assistant")).toEqual([
      "cadet",
      "exec",
      "--",
      "ls",
    ]);
  });
});

describe("basetenExecArgs", () => {
  test("the exec rides the CLI's sandbox exec with the sandbox's name", () => {
    expect(basetenExecArgs("sbx-1", ["cadet", "ps"])).toEqual([
      "sandbox",
      "exec",
      "--name",
      "sbx-1",
      "--",
      "cadet",
      "ps",
    ]);
  });

  test("the team selection and stdin forwarding ride their flags", () => {
    expect(
      basetenExecArgs("sbx-1", ["cadet", "ps"], {
        team: "team-abc123",
        stdin: true,
        timeoutSeconds: 90,
      }),
    ).toEqual([
      "sandbox",
      "exec",
      "--name",
      "sbx-1",
      "--team",
      "team-abc123",
      "--stdin",
      "--timeout",
      "90s",
      "--",
      "cadet",
      "ps",
    ]);
  });
});

describe("consumeBasetenExecEvent", () => {
  const chunks: string[] = [];
  afterEach(() => {
    chunks.length = 0;
  });

  test("output events stream their data; the result event answers the exit code", () => {
    const sink = (chunk: string) => chunks.push(chunk);
    expect(
      consumeBasetenExecEvent(
        { type: "stdout", data: "hello " } as BasetenExecEvent,
        sink,
      ),
    ).toBeNull();
    expect(
      consumeBasetenExecEvent(
        { type: "stderr", data: "hmm" } as BasetenExecEvent,
        sink,
      ),
    ).toBeNull();
    expect(chunks).toEqual(["hello ", "hmm"]);
    expect(
      consumeBasetenExecEvent(
        {
          type: "result",
          data: JSON.stringify({ exitCode: 3 }),
        } as BasetenExecEvent,
        sink,
      ),
    ).toBe(3);
  });

  test("a result without an exit code fails loudly rather than lying green", () => {
    expect(
      consumeBasetenExecEvent({ type: "result" } as BasetenExecEvent, () => {}),
    ).toBe(1);
  });
});

describe("execBasetenSandbox — the execution-API arm", () => {
  let fetchSpy: ReturnType<typeof spyOn> | null = null;
  let cli: ReturnType<typeof spyOn> | null = null;

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    cli?.mockRestore();
    cli = null;
  });

  beforeEach(() => {
    // This box has a real `baseten` CLI on PATH; the HTTP arm's tests run
    // against the machine it would have on a clean install.
    cli = spyOn(basetenCli, "resolveBasetenCli").mockResolvedValue(null);
  });

  function ndjsonResponse(lines: string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }

  /** The fetch mock, installed through the spy the other suites here use. */
  function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => handler(String(url), init)) as typeof fetch);
  }

  test("the exec streams the NDJSON events and reports the command's exit code", async () => {
    saveBasetenSandboxToken("a-1", "sbx-token-1");
    const chunks: Array<[string, string]> = [];
    mockFetch(() =>
      ndjsonResponse([
        JSON.stringify({ type: "stdout", data: "pid 1 up" }),
        JSON.stringify({ type: "stderr", data: "warn" }),
        JSON.stringify({
          type: "result",
          data: JSON.stringify({ exitCode: 0, status: "exited" }),
        }),
      ]),
    );

    const { code } = await execBasetenSandbox({
      assistantId: "a-1",
      sandboxUrl: "https://sbx.example.b10.co/",
      name: "sbx-1",
      command: ["cadet", "ps"],
      onOutput: (chunk, stream) => chunks.push([chunk, stream]),
    });

    expect(code).toBe(0);
    expect(chunks).toEqual([
      ["pid 1 up", "stdout"],
      ["warn", "stderr"],
    ]);
  });

  test("the command travels as one quoted shell line, authed by the sandbox token", async () => {
    saveBasetenSandboxToken("a-1", "sbx-token-1");
    let seenUrl = "";
    let seenAuth = "";
    let seenBody = "";
    mockFetch((url, init) => {
      seenUrl = url;
      seenAuth = String(new Headers(init?.headers).get("Authorization"));
      seenBody = String(init?.body);
      return ndjsonResponse([
        JSON.stringify({ type: "result", data: JSON.stringify({ exitCode: 0 }) }),
      ]);
    });

    await execBasetenSandbox({
      assistantId: "a-1",
      sandboxUrl: "https://sbx.example.b10.co",
      name: "sbx-1",
      command: ["echo", "a b"],
    });

    expect(seenUrl).toBe("https://sbx.example.b10.co/process");
    expect(seenAuth).toBe("Bearer sbx-token-1");
    // The command rides the sandbox's own cadet exec — the runtime in
    // there resolves the service's working directory.
    expect(seenBody).toBe(
      JSON.stringify({ command: "cadet exec -- echo 'a b'" }),
    );
  });

  test("without the sandbox token the exec refuses with the re-hatch hint", async () => {
    let called = 0;
    mockFetch(() => {
      called += 1;
      return ndjsonResponse([]);
    });

    let message = "";
    try {
      await execBasetenSandbox({
        assistantId: "never-hatched",
        sandboxUrl: "https://sbx.example.b10.co",
        name: "sbx-1",
        command: ["true"],
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("re-run `cadet hatch --remote baseten`");
    expect(called).toBe(0);
  });
});
