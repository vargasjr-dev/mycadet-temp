/**
 * Tests for `gateway contacts`. Run through the commander program with a
 * stub IPC caller injected, so the suite covers the flag-to-command
 * adaptation and the execute layer without a live gateway socket.
 */

import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import { buildGatewayCliProgram } from "../program.js";

import type { GatewayIpcCall } from "../contacts.js";

let lastIpc: { method: string; params?: Record<string, unknown> } | null = null;
let ipcResult: unknown = { ok: true, contacts: [] };

const ipc: GatewayIpcCall = async (method, params) => {
  lastIpc = { method, params };
  return ipcResult;
};

let stdout: string[];
let stderr: string[];

async function run(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  stdout = [];
  stderr = [];
  const logSpy = spyOn(console, "log").mockImplementation(
    (...parts: unknown[]) => {
      stdout.push(parts.map(String).join(" "));
    },
  );
  const errorSpy = spyOn(console, "error").mockImplementation(
    (...parts: unknown[]) => {
      stderr.push(parts.map(String).join(" "));
    },
  );
  // Commander writes help and parse-error text straight to the streams —
  // capture those too, or help/error assertions read empty.
  const outSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const errSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const exitSpy = spyOn(process, "exit").mockImplementation(
    (code?: number): never => {
      throw new Error(`exit:${code}`);
    },
  );
  try {
    await buildGatewayCliProgram(ipc).parseAsync(args, { from: "user" });
    return { code: 0, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } catch (e) {
    const match = /^exit:(-?\d+)$/.exec(e instanceof Error ? e.message : "");
    if (match) {
      return {
        code: Number(match[1]),
        stdout: stdout.join("\n"),
        stderr: stderr.join("\n"),
      };
    }
    throw e;
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    outSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

beforeEach(() => {
  lastIpc = null;
  ipcResult = { ok: true, contacts: [] };
});

describe("gateway contacts set-risk-threshold", () => {
  test("writes a ceiling over IPC", async () => {
    ipcResult = { ok: true, contactId: "contact-1", threshold: "high" };
    const { code, stdout } = await run([
      "contacts",
      "set-risk-threshold",
      "contact-1",
      "--threshold",
      "high",
    ]);
    expect(code).toBe(0);
    expect(lastIpc).toEqual({
      method: "set_contact_threshold",
      params: { contactId: "contact-1", threshold: "high" },
    });
    expect(stdout).toContain("Set assistant access for contact-1 to high");
  });

  test("maps inherit to a null ceiling", async () => {
    ipcResult = { ok: true, contactId: "contact-1", threshold: null };
    const { code, stdout } = await run([
      "contacts",
      "set-risk-threshold",
      "contact-1",
      "--threshold",
      "inherit",
    ]);
    expect(code).toBe(0);
    expect(lastIpc?.params).toEqual({
      contactId: "contact-1",
      threshold: null,
    });
    expect(stdout).toContain("Set assistant access for contact-1 to inherit");
  });

  test("rejects an unknown threshold without calling IPC", async () => {
    const { code, stderr } = await run([
      "contacts",
      "set-risk-threshold",
      "contact-1",
      "--threshold",
      "full",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("full");
    expect(lastIpc).toBeNull();
  });

  test("maps a missing contact to exit 1", async () => {
    ipcResult = { ok: false, error: "not_found" };
    const { code, stderr } = await run([
      "contacts",
      "set-risk-threshold",
      "contact-missing",
      "--threshold",
      "high",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("not found");
  });

  test("exits 1 when the gateway is unreachable", async () => {
    ipcResult = undefined;
    const { code, stderr } = await run([
      "contacts",
      "set-risk-threshold",
      "contact-1",
      "--threshold",
      "high",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("unreachable");
  });
});

describe("gateway contacts list and get", () => {
  test("lists contacts over IPC", async () => {
    ipcResult = {
      ok: true,
      contacts: [
        {
          id: "contact-1",
          displayName: "Alice",
          role: "contact",
          autoApproveThreshold: "high",
        },
      ],
    };
    const { code, stdout } = await run(["contacts", "list"]);
    expect(code).toBe(0);
    expect(lastIpc).toEqual({
      method: "contacts_list_rich",
      params: {},
    });
    expect(stdout).toContain("contact-1");
    expect(stdout).toContain("Alice");
    expect(stdout).toContain("access:high");
  });

  test("filters the list by role", async () => {
    const { code } = await run(["contacts", "list", "--role", "guardian"]);
    expect(code).toBe(0);
    expect(lastIpc).toEqual({
      method: "contacts_list_rich",
      params: { role: "guardian" },
    });
  });

  test("gets one contact over IPC", async () => {
    ipcResult = {
      ok: true,
      contact: {
        id: "contact-1",
        displayName: "Alice",
        role: "contact",
        autoApproveThreshold: null,
      },
    };
    const { code, stdout } = await run(["contacts", "get", "contact-1"]);
    expect(code).toBe(0);
    expect(lastIpc).toEqual({
      method: "contacts_get_rich",
      params: { contactId: "contact-1" },
    });
    expect(stdout).toContain("Access:       inherit");
  });
});
