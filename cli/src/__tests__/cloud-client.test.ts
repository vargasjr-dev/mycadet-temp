import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mock } from "bun:test";

import {
  clearCloudToken,
  fetchAssistantDetail,
  fetchUpgradeInProgress,
  getCloudUrl,
  readCloudToken,
  saveCloudToken,
} from "../lib/cloud-client.js";

describe("cloud-client token path is env-scoped", () => {
  let tempHome: string;
  let savedXdg: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedEnv = process.env.CADET_ENVIRONMENT;
    tempHome = mkdtempSync(join(tmpdir(), "cli-cloud-client-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    delete process.env.CADET_ENVIRONMENT;
  });

  afterEach(() => {
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
    if (savedEnv === undefined) {
      delete process.env.CADET_ENVIRONMENT;
    } else {
      process.env.CADET_ENVIRONMENT = savedEnv;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("prod (CADET_ENVIRONMENT unset) writes to $XDG_CONFIG_HOME/cadet/cloud-token", () => {
    const token = "vak_prod_token_123";
    saveCloudToken(token);

    const prodPath = join(tempHome, "cadet", "cloud-token");
    expect(existsSync(prodPath)).toBe(true);
    expect(readFileSync(prodPath, "utf-8").trim()).toBe(token);
    expect(readCloudToken()).toBe(token);
  });

  test("dev (CADET_ENVIRONMENT=dev) writes to $XDG_CONFIG_HOME/cadet-dev/cloud-token", () => {
    process.env.CADET_ENVIRONMENT = "dev";
    const token = "vak_dev_token_456";
    saveCloudToken(token);

    const devPath = join(tempHome, "cadet-dev", "cloud-token");
    expect(existsSync(devPath)).toBe(true);
    expect(readFileSync(devPath, "utf-8").trim()).toBe(token);

    const prodPath = join(tempHome, "cadet", "cloud-token");
    expect(existsSync(prodPath)).toBe(false);

    expect(readCloudToken()).toBe(token);
  });

  test("prod and dev tokens are isolated on disk", () => {
    // Save prod token
    delete process.env.CADET_ENVIRONMENT;
    saveCloudToken("prod-token");

    // Switch to dev and save a different token
    process.env.CADET_ENVIRONMENT = "dev";
    saveCloudToken("dev-token");

    // Dev read returns dev
    expect(readCloudToken()).toBe("dev-token");

    // Switch back to prod — prod value is unchanged
    delete process.env.CADET_ENVIRONMENT;
    expect(readCloudToken()).toBe("prod-token");

    // Files live at distinct paths
    expect(
      readFileSync(join(tempHome, "cadet", "cloud-token"), "utf-8").trim(),
    ).toBe("prod-token");
    expect(
      readFileSync(
        join(tempHome, "cadet-dev", "cloud-token"),
        "utf-8",
      ).trim(),
    ).toBe("dev-token");
  });

  test("clearCloudToken removes only the env-scoped token", () => {
    // Prod token
    delete process.env.CADET_ENVIRONMENT;
    saveCloudToken("prod-token");

    // Dev token
    process.env.CADET_ENVIRONMENT = "dev";
    saveCloudToken("dev-token");

    // Clear dev
    clearCloudToken();
    expect(existsSync(join(tempHome, "cadet-dev", "cloud-token"))).toBe(
      false,
    );

    // Prod still there
    expect(existsSync(join(tempHome, "cadet", "cloud-token"))).toBe(true);
  });
});

describe("getCloudUrl resolution order", () => {
  let tempLockDir: string;
  let savedLockDir: string | undefined;
  let savedEnv: string | undefined;
  let savedCloudUrl: string | undefined;

  beforeEach(() => {
    savedLockDir = process.env.CADET_LOCKFILE_DIR;
    savedEnv = process.env.CADET_ENVIRONMENT;
    savedCloudUrl = process.env.CADET_CLOUD_URL;
    tempLockDir = mkdtempSync(join(tmpdir(), "cli-cloud-url-test-"));
    process.env.CADET_LOCKFILE_DIR = tempLockDir;
    delete process.env.CADET_ENVIRONMENT;
    delete process.env.CADET_CLOUD_URL;
  });

  afterEach(() => {
    if (savedLockDir === undefined) {
      delete process.env.CADET_LOCKFILE_DIR;
    } else {
      process.env.CADET_LOCKFILE_DIR = savedLockDir;
    }
    if (savedEnv === undefined) {
      delete process.env.CADET_ENVIRONMENT;
    } else {
      process.env.CADET_ENVIRONMENT = savedEnv;
    }
    if (savedCloudUrl === undefined) {
      delete process.env.CADET_CLOUD_URL;
    } else {
      process.env.CADET_CLOUD_URL = savedCloudUrl;
    }
    rmSync(tempLockDir, { recursive: true, force: true });
  });

  function writeLockfile(data: Record<string, unknown>): void {
    // CADET_ENVIRONMENT is unset → production env → config-dir lockfile.json.
    writeFileSync(
      join(tempLockDir, "lockfile.json"),
      JSON.stringify(data, null, 2),
    );
  }

  test("returns lockfile cloudBaseUrl when set", () => {
    writeLockfile({ cloudBaseUrl: "https://staging.mycadet.ai" });
    expect(getCloudUrl()).toBe("https://staging.mycadet.ai");
  });

  test("lockfile cloudBaseUrl takes priority over CADET_CLOUD_URL", () => {
    writeLockfile({ cloudBaseUrl: "https://lockfile.mycadet.ai" });
    process.env.CADET_CLOUD_URL = "https://env.mycadet.ai";
    expect(getCloudUrl()).toBe("https://lockfile.mycadet.ai");
  });

  test("falls back to CADET_CLOUD_URL when lockfile is missing", () => {
    process.env.CADET_CLOUD_URL = "https://env-only.mycadet.ai";
    expect(getCloudUrl()).toBe("https://env-only.mycadet.ai");
  });

  test("falls back to CADET_CLOUD_URL when lockfile has no cloudBaseUrl", () => {
    writeLockfile({ assistants: [] });
    process.env.CADET_CLOUD_URL = "https://env-fallback.mycadet.ai";
    expect(getCloudUrl()).toBe("https://env-fallback.mycadet.ai");
  });

  test("falls back to CADET_CLOUD_URL when lockfile cloudBaseUrl is blank", () => {
    writeLockfile({ cloudBaseUrl: "   " });
    process.env.CADET_CLOUD_URL = "https://env-after-blank.mycadet.ai";
    expect(getCloudUrl()).toBe("https://env-after-blank.mycadet.ai");
  });

  test("falls back to prod env seed URL when lockfile and CADET_CLOUD_URL are unset (prod env)", () => {
    // CADET_ENVIRONMENT is unset → production → prod seed URL.
    expect(getCloudUrl()).toBe("https://cloud.mycadet.ai");
  });

  test("falls back to dev env seed URL when CADET_ENVIRONMENT=dev", () => {
    process.env.CADET_ENVIRONMENT = "dev";
    expect(getCloudUrl()).toBe("https://dev-cloud.mycadet.ai");
  });

  test("trims whitespace from CADET_CLOUD_URL", () => {
    process.env.CADET_CLOUD_URL = "  https://trimmed.mycadet.ai  ";
    expect(getCloudUrl()).toBe("https://trimmed.mycadet.ai");
  });
});

describe("fetchAssistantDetail / fetchUpgradeInProgress", () => {
  // vak_ token → authHeaders skips the org-ID fetch, so the single mocked
  // fetch call is the endpoint under test.
  const TOKEN = "vak_test_token";
  const ASSISTANT_ID = "11111111-2222-3333-4444-555555555555";
  const PLATFORM_URL = "https://platform.test";

  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchJson(body: unknown, status = 200) {
    const fetchMock = mock(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(body), { status }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    return fetchMock;
  }

  function mockFetchNetworkError() {
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
  }

  test("fetchAssistantDetail maps fields", async () => {
    const fetchMock = mockFetchJson({
      current_release_version: "0.7.0",
      release_channel: "preview",
    });
    const detail = await fetchAssistantDetail(
      TOKEN,
      ASSISTANT_ID,
      PLATFORM_URL,
    );
    expect(detail).toEqual({
      currentReleaseVersion: "0.7.0",
      releaseChannel: "preview",
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`${PLATFORM_URL}/v1/assistants/${ASSISTANT_ID}/`);
  });

  test("fetchAssistantDetail defaults missing fields", async () => {
    mockFetchJson({});
    const detail = await fetchAssistantDetail(
      TOKEN,
      ASSISTANT_ID,
      PLATFORM_URL,
    );
    expect(detail).toEqual({
      currentReleaseVersion: null,
      releaseChannel: "stable",
    });
  });

  test("fetchAssistantDetail returns null on non-OK", async () => {
    mockFetchJson({ detail: "not found" }, 404);
    expect(
      await fetchAssistantDetail(TOKEN, ASSISTANT_ID, PLATFORM_URL),
    ).toBeNull();
  });

  test("fetchAssistantDetail returns null on network error", async () => {
    mockFetchNetworkError();
    expect(
      await fetchAssistantDetail(TOKEN, ASSISTANT_ID, PLATFORM_URL),
    ).toBeNull();
  });

  test("fetchUpgradeInProgress returns the boolean", async () => {
    const fetchMock = mockFetchJson({ in_progress: true });
    expect(
      await fetchUpgradeInProgress(TOKEN, ASSISTANT_ID, PLATFORM_URL),
    ).toBe(true);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(
      `${PLATFORM_URL}/v1/assistants/${ASSISTANT_ID}/upgrade-status/`,
    );

    mockFetchJson({ in_progress: false });
    expect(
      await fetchUpgradeInProgress(TOKEN, ASSISTANT_ID, PLATFORM_URL),
    ).toBe(false);
  });

  test("fetchUpgradeInProgress returns null on 404 (older platform)", async () => {
    mockFetchJson({ detail: "not found" }, 404);
    expect(
      await fetchUpgradeInProgress(TOKEN, ASSISTANT_ID, PLATFORM_URL),
    ).toBeNull();
  });

  test("fetchUpgradeInProgress returns null on network error", async () => {
    mockFetchNetworkError();
    expect(
      await fetchUpgradeInProgress(TOKEN, ASSISTANT_ID, PLATFORM_URL),
    ).toBeNull();
  });

  test("fetchUpgradeInProgress returns null on a malformed body", async () => {
    mockFetchJson({ something_else: 1 });
    expect(
      await fetchUpgradeInProgress(TOKEN, ASSISTANT_ID, PLATFORM_URL),
    ).toBeNull();
  });
});
