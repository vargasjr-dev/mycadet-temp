import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";

import { ensureBinaryInstalled, readLineText } from "../lib/ensure-binary.js";

/** A real Writable capturing everything written, as a test output stream. */
function makeOutput(): { writable: Writable; text(): string } {
  const captured: string[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      captured.push(chunk.toString());
      callback();
    },
  });
  return { writable, text: () => captured.join("") };
}

describe("ensureBinaryInstalled", () => {
  test("returns the existing probe result without prompting", async () => {
    const output = makeOutput();
    const version = await ensureBinaryInstalled({
      binary: "nginx",
      purpose: "the app server",
      packages: { brew: ["brew", "install", "nginx"] },
      manualHint: "install nginx",
      probe: () => "nginx version 1.2",
      confirmInstall: () => {
        throw new Error("must not prompt for a present binary");
      },
      streams: { output: output.writable },
    });
    expect(version).toBe("nginx version 1.2");
    expect(output.text()).toBe("");
  });

  test("offers to install and runs the first available package manager", async () => {
    const output = makeOutput();
    const installed: string[][] = [];
    let probeCalls = 0;
    const version = await ensureBinaryInstalled({
      binary: "nginx",
      purpose: "the app server",
      packages: {
        brew: ["brew", "install", "nginx"],
        "apt-get": ["sudo", "apt-get", "install", "-y", "nginx"],
      },
      manualHint: "install nginx yourself",
      probe: () => (++probeCalls > 1 ? "nginx version 1.2" : null),
      pmAvailable: (pm) => pm === "apt-get",
      runInstall: (argv) => {
        installed.push(argv);
        return true;
      },
      confirmInstall: async () => true,
      streams: { output: output.writable },
    });
    expect(version).toBe("nginx version 1.2");
    expect(installed).toEqual([["sudo", "apt-get", "install", "-y", "nginx"]]);
    expect(output.text()).toContain("isn't installed");
    expect(output.text()).not.toContain("apt-get install");
  });

  test("the default confirm takes Enter as yes", async () => {
    const output = makeOutput();
    const input = Object.assign(new Readable({ read() {} }), {
      isTTY: true,
    });
    const installed: string[][] = [];
    let probeCalls = 0;
    const pending = ensureBinaryInstalled({
      binary: "nginx",
      purpose: "the app server",
      packages: { brew: ["brew", "install", "nginx"] },
      manualHint: "install nginx yourself",
      probe: () => (++probeCalls > 1 ? "nginx version 1.2" : null),
      pmAvailable: () => true,
      runInstall: (argv) => {
        installed.push(argv);
        return true;
      },
      streams: { input, output: output.writable },
    });
    input.emit("data", "\n");
    expect(await pending).toBe("nginx version 1.2");
    expect(installed).toEqual([["brew", "install", "nginx"]]);
    expect(output.text()).toContain("Install nginx now?");
  });

  test("a declined offer prints the manual hint and installs nothing", async () => {
    const output = makeOutput();
    let ran = false;
    const version = await ensureBinaryInstalled({
      binary: "ngrok",
      purpose: "the ngrok tunnel",
      packages: { brew: ["brew", "install", "ngrok/ngrok/ngrok"] },
      manualHint: "get ngrok from ngrok.com",
      probe: () => null,
      runInstall: () => {
        ran = true;
        return true;
      },
      confirmInstall: async () => false,
      streams: { output: output.writable },
    });
    expect(version).toBe(null);
    expect(ran).toBe(false);
    expect(output.text()).toContain("get ngrok from ngrok.com");
  });

  test("a failed install falls back to the manual hint", async () => {
    const output = makeOutput();
    const version = await ensureBinaryInstalled({
      binary: "nginx",
      purpose: "the app server",
      packages: { brew: ["brew", "install", "nginx"] },
      manualHint: "install nginx yourself",
      probe: () => null,
      runInstall: () => false,
      confirmInstall: async () => true,
      streams: { output: output.writable },
    });
    expect(version).toBe(null);
    expect(output.text()).toContain("install nginx yourself");
  });

  test("no matching package manager prints the hint", async () => {
    const output = makeOutput();
    let ran = false;
    const version = await ensureBinaryInstalled({
      binary: "cloudflared",
      purpose: "the cloudflare tunnel",
      packages: { brew: ["brew", "install", "cloudflared"] },
      manualHint: "cloudflared install docs",
      probe: () => null,
      pmAvailable: () => false,
      runInstall: () => {
        ran = true;
        return true;
      },
      confirmInstall: async () => true,
      streams: { output: output.writable },
    });
    expect(version).toBe(null);
    expect(ran).toBe(false);
    expect(output.text()).toContain("cloudflared install docs");
  });

  test("a non-interactive terminal declines instead of hanging", async () => {
    const version = await ensureBinaryInstalled({
      binary: "nginx",
      purpose: "the app server",
      packages: { brew: ["brew", "install", "nginx"] },
      manualHint: "install nginx yourself",
      probe: () => null,
      confirmInstall: async () => {
        throw new Error("Install confirm requires an interactive terminal.");
      },
    });
    expect(version).toBe(null);
  });
});

describe("readLineText", () => {
  test("resolves the first line and ignores the rest", async () => {
    const output = makeOutput();
    const input = new Readable({ read() {} });
    const pending = readLineText("token: ", {
      input,
      output: output.writable,
    });
    input.emit("data", "abc123\nsecond line\n");
    expect(await pending).toBe("abc123");
    expect(output.text()).toBe("token: ");
  });

  test("resolves an empty line on an immediate newline", async () => {
    const input = new Readable({ read() {} });
    const pending = readLineText("[Y/n] ", { input });
    input.emit("data", "\n");
    expect(await pending).toBe("");
  });
});

test("a Mac without Homebrew asks separately before bootstrapping and installing nginx", async () => {
  const installs: string[][] = [];
  let homebrew = false;
  let nginx = false;
  let brewPrompts = 0;
  const version = await ensureBinaryInstalled({
    binary: "nginx",
    purpose: "the app server",
    platform: "darwin",
    packages: { brew: ["brew", "install", "nginx"] },
    manualHint: "install nginx",
    probe: () => (nginx ? "nginx 1.2" : null),
    pmAvailable: (pm) => pm === "brew" && homebrew,
    confirmInstall: async () => true,
    confirmHomebrewInstall: async () => {
      brewPrompts++;
      return true;
    },
    runInstall: (argv) => {
      installs.push(argv);
      if (argv[0] === "/bin/bash") homebrew = true;
      if (argv[0] === "brew") nginx = true;
      return true;
    },
  });
  expect(version).toBe("nginx 1.2");
  expect(brewPrompts).toBe(1);
  expect(installs.length).toBe(2);
  expect(installs[1]).toEqual(["brew", "install", "nginx"]);
});

test("declining Homebrew runs no installer", async () => {
  const installs: string[][] = [];
  const result = await ensureBinaryInstalled({
    binary: "ngrok",
    purpose: "a tunnel",
    platform: "darwin",
    packages: { brew: ["brew", "install", "ngrok/ngrok/ngrok"] },
    manualHint: "install ngrok",
    probe: () => null,
    pmAvailable: () => false,
    confirmInstall: async () => true,
    confirmHomebrewInstall: async () => false,
    runInstall: (argv) => {
      installs.push(argv);
      return true;
    },
  });
  expect(result).toBeNull();
  expect(installs).toEqual([]);
});
