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
process.env.CADET_LOCKFILE_DIR = testDir;

import * as assistantConfig from "../lib/assistant-config.js";
import * as guardianToken from "../lib/guardian-token.js";
import * as localRuntimeClient from "../lib/local-runtime-client.js";
import * as cloudClient from "../lib/cloud-client.js";
import { withPreconnect } from "./helpers/http.js";
import { makeGuardianTokenData } from "./helpers/guardian-token.js";

const resolveTargetMock = spyOn(
  assistantConfig,
  "resolveTargetAssistant",
).mockImplementation(() => {
  throw new Error("process.exit:1");
});
const readCloudTokenMock = spyOn(
  cloudClient,
  "readCloudToken",
).mockReturnValue("platform-token");
const exportMock = spyOn(
  localRuntimeClient,
  "localRuntimeExportToGcs",
).mockResolvedValue({ jobId: "job-1" });
const identityMock = spyOn(
  localRuntimeClient,
  "localRuntimeIdentity",
).mockResolvedValue({ version: "0.12.3" });
const pollMock = spyOn(
  localRuntimeClient,
  "localRuntimePollJobStatus",
).mockResolvedValue({
  jobId: "job-1",
  type: "export",
  status: "complete",
});
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
} satisfies assistantConfig.AssistantEntry;

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
  identityMock.mockReset();
  identityMock.mockResolvedValue({ version: "0.12.3" });
  leaseGuardianTokenSpy.mockClear();
  readCloudTokenMock.mockReset();
  readCloudTokenMock.mockReturnValue("platform-token");
  exportMock.mockClear();
  pollMock.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
});

afterAll(() => {
  resolveTargetMock.mockRestore();
  identityMock.mockRestore();
  leaseGuardianTokenSpy.mockRestore();
  readCloudTokenMock.mockRestore();
  exportMock.mockRestore();
  pollMock.mockRestore();
  loadGuardianTokenSpy.mockRestore();
  rmSync(testDir, { recursive: true, force: true });
});

describe("cadet debug", () => {
  test("mints the URL on the cloud, exports with the debug profile, and waits", async () => {
    await debug();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      "https://cloud.mycadet.ai/v1/assistants/11111111-2222-3333-4444-555555555555/debug-bundle-upload-url/",
    );
    expect(fetchCalls[0].init?.method).toBe("POST");
    expect(
      new Headers(fetchCalls[0].init?.headers).get("Cadet-Organization-Id"),
    ).toBe("org-1");

    expect(exportMock).toHaveBeenCalledTimes(1);
    const [entry, token, params] = exportMock.mock.calls[0];
    expect(entry).toBe(LOCAL_ENTRY);
    expect(token).toBe("local-token");
    expect(params).toEqual({
      uploadUrl: "https://storage.googleapis.com/b/signed",
      description: "debug bundle for Cadet staff",
      profile: "debug",
    });
    expect(pollMock).toHaveBeenCalled();
    // The daemon was checked for the debug profile before the cloud call.
    expect(identityMock).toHaveBeenCalledTimes(1);
  });

  test("passes an unquoted multi-word display name through to the shared resolver", async () => {
    process.argv = ["bun", "cadet", "debug", "Support", "Bot"];
    await debug();
    expect(resolveTargetMock).toHaveBeenCalledWith("Support Bot");
  });

  test("refuses a daemon older than the debug profile before any URL is minted", async () => {
    // Such a daemon strips `profile` and would upload the owner's
    // credentials to the staff bucket.
    identityMock.mockResolvedValue({ version: "0.12.2" });
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((msg) => {
      errors.push(String(msg));
    });
    try {
      await expect(debug()).rejects.toThrow("process.exit:1");
    } finally {
      errorSpy.mockRestore();
    }
    expect(errors.join("\n")).toContain("0.12.3");
    expect(fetchCalls).toHaveLength(0);
    expect(exportMock).not.toHaveBeenCalled();
  });

  test("re-leases the guardian token when the daemon answers 401 mid-poll", async () => {
    pollMock.mockReset();
    let polls = 0;
    pollMock.mockImplementation(async (_entry, token) => {
      polls += 1;
      if (polls === 1) {
        throw new Error("Local job status check failed: 401 Unauthorized");
      }
      expect(token).toBe("leased-token");
      return {
        jobId: "job-1",
        type: "export",
        status: "complete",
      };
    });

    await debug();

    expect(leaseGuardianTokenSpy).toHaveBeenCalledTimes(1);
    expect(polls).toBe(2);
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
    expect(exportMock).not.toHaveBeenCalled();
  });

  test("refuses a Cadet-hosted assistant, which needs no bundle", async () => {
    resolveTargetMock.mockReturnValue({
      ...LOCAL_ENTRY,
      cloud: "cadet",
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
