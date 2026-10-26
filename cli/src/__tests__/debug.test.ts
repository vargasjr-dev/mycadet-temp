import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Lockfile isolation (mirrors backup.test.ts)
const testDir = mkdtempSync(join(tmpdir(), "cli-debug-test-"));
process.env.XDG_CONFIG_HOME = testDir;

import * as assistantConfig from "../lib/assistant-config.js";
import * as guardianToken from "../lib/guardian-token.js";
import * as cloudClient from "../lib/cloud-client.js";
import { withPreconnect } from "./helpers/http.js";
import { makeGuardianTokenData } from "./helpers/guardian-token.js";

const resolveTargetMock = spyOn(
  assistantConfig,
  "resolveTargetAssistant",
).mockImplementation(() => {
  throw new Error("process.exit:1");
});
const readCloudTokenMock = spyOn(cloudClient, "readCloudToken").mockReturnValue(
  "platform-token",
);
const loadGuardianTokenSpy = spyOn(
  guardianToken,
  "loadGuardianToken",
).mockReturnValue(
  makeGuardianTokenData({
    accessToken: "local-token",
    accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }),
);
const leaseGuardianTokenSpy = spyOn(
  guardianToken,
  "leaseGuardianToken",
).mockResolvedValue(
  makeGuardianTokenData({
    accessToken: "leased-token",
    accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }),
);

const { debug } = await import("../commands/debug.js");

const LOCAL_ENTRY = {
  name: "mine",
  assistantId: "local-asst-1",
  runtimeUrl: "http://127.0.0.1:7821",
  cloud: "local",
  hatchedAt: new Date().toISOString(),
  cloudAssistantId: "11111111-2222-3333-4444-555555555555",
  cloudBaseUrl: "https://cloud.mycadet.ai",
  cloudOrganizationId: "org-1",
} satisfies assistantConfig.LockfileAssistant;

let originalFetch: typeof globalThis.fetch;
let originalExit: typeof process.exit;
let fetchCalls: { url: string; init?: RequestInit }[] = [];
let uploadUrlStatus = 201;

beforeEach(() => {
  process.argv = ["bun", "cadet", "debug"];
  originalFetch = globalThis.fetch;
  originalExit = process.exit;
  process.exit = mock((code?: number | string | undefined): never => {
    throw new Error(`process.exit:${code}`);
  });
  fetchCalls = [];
  uploadUrlStatus = 201;
  globalThis.fetch = withPreconnect(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({ url: "https://storage.googleapis.com/b/signed" }),
        {
          status: uploadUrlStatus,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  );
  resolveTargetMock.mockReset();
  resolveTargetMock.mockReturnValue(LOCAL_ENTRY);
  leaseGuardianTokenSpy.mockClear();
  readCloudTokenMock.mockReset();
  readCloudTokenMock.mockReturnValue("platform-token");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
});

afterAll(() => {
  resolveTargetMock.mockRestore();
  leaseGuardianTokenSpy.mockRestore();
  readCloudTokenMock.mockRestore();
  loadGuardianTokenSpy.mockRestore();
  rmSync(testDir, { recursive: true, force: true });
});

describe("cadet debug", () => {
  test("requests sanitized logs and uploads them without runtime export jobs", async () => {
    await debug();
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://cloud.mycadet.ai/v1/assistants/11111111-2222-3333-4444-555555555555/debug-bundle-upload-url/",
      "http://127.0.0.1:7821/v1/logs/export",
      "https://storage.googleapis.com/b/signed",
    ]);
    expect(fetchCalls[1].init?.method).toBe("POST");
    expect(new Headers(fetchCalls[1].init?.headers).get("Authorization")).toBe(
      "Bearer local-token",
    );
    expect(fetchCalls[2].init?.method).toBe("PUT");
    expect(new Headers(fetchCalls[2].init?.headers).has("Authorization")).toBe(
      false,
    );
    expect(fetchCalls[2].init?.body).toBeInstanceOf(Blob);
  });

  test("passes an unquoted multi-word display name through to the shared resolver", async () => {
    process.argv = ["bun", "cadet", "debug", "Support", "Bot"];
    await debug();
    expect(resolveTargetMock).toHaveBeenCalledWith("Support Bot");
  });

  test("explains what to turn on when the cloud refuses", async () => {
    uploadUrlStatus = 403;
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((msg) => {
      errors.push(String(msg));
    });
    try {
      await expect(debug()).rejects.toThrow("process.exit:1");
    } finally {
      errorSpy.mockRestore();
    }
    expect(errors.join("\n")).toContain("Allow Staff Access");
  });

  test("refuses a Cadet-hosted assistant, which needs no bundle", async () => {
    resolveTargetMock.mockReturnValue({
      ...LOCAL_ENTRY,
      cloud: "cloud",
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(debug()).rejects.toThrow("process.exit:1");
    } finally {
      errorSpy.mockRestore();
    }
    expect(fetchCalls).toHaveLength(0);
  });

  test("asks for a login when the assistant is not registered", async () => {
    resolveTargetMock.mockReturnValue({
      ...LOCAL_ENTRY,
      cloudAssistantId: undefined,
    });
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((msg) => {
      errors.push(String(msg));
    });
    try {
      await expect(debug()).rejects.toThrow("process.exit:1");
    } finally {
      errorSpy.mockRestore();
    }
    expect(errors.join("\n")).toContain("cadet login");
    expect(fetchCalls).toHaveLength(0);
  });
});
