import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCloudToken } from "@mycadet/local-mode";
import { getCloudBaseUrl } from "@mycadet/shared";
import { mock } from "bun:test";

import {
  clearCloudToken,
  fetchCloudAssistants,
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
      readFileSync(join(tempHome, "cadet-dev", "cloud-token"), "utf-8").trim(),
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
    expect(existsSync(join(tempHome, "cadet-dev", "cloud-token"))).toBe(false);

    // Prod still there
    expect(existsSync(join(tempHome, "cadet", "cloud-token"))).toBe(true);
  });
});

describe("getCloudBaseUrl resolution order", () => {
  let savedEnv: string | undefined;
  let savedCloudUrl: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.CADET_ENVIRONMENT;
    savedCloudUrl = process.env.CADET_CLOUD_URL;
    delete process.env.CADET_ENVIRONMENT;
    delete process.env.CADET_CLOUD_URL;
  });

  afterEach(() => {
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
  });

  test("returns CADET_CLOUD_URL when set", () => {
    process.env.CADET_CLOUD_URL = "https://env-only.mycadet.ai";
    expect(getCloudBaseUrl()).toBe("https://env-only.mycadet.ai");
  });

  test("CADET_CLOUD_URL takes priority over the environment seed", () => {
    process.env.CADET_CLOUD_URL = "https://env.mycadet.ai";
    process.env.CADET_ENVIRONMENT = "dev";
    expect(getCloudBaseUrl()).toBe("https://env.mycadet.ai");
  });

  test("falls back to production when nothing signals an environment", () => {
    // No CADET_ENVIRONMENT, no version channel suffix, no persisted default —
    // resolveEnvironmentName's last step is the production seed.
    expect(getCloudBaseUrl()).toBe("https://mycadet.ai");
  });

  test("falls back to the dev seed URL when CADET_ENVIRONMENT=dev", () => {
    process.env.CADET_ENVIRONMENT = "dev";
    expect(getCloudBaseUrl()).toBe("https://dev.mycadet.ai");
  });

  test("trims whitespace from CADET_CLOUD_URL", () => {
    process.env.CADET_CLOUD_URL = "  https://trimmed.mycadet.ai  ";
    expect(getCloudBaseUrl()).toBe("https://trimmed.mycadet.ai");
  });
});

// Shared fetch stubs — pure module-scope helpers, no env coupling.
const CLOUD_URL = "https://test.mycadet.ai";
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

function usePlatformUrl() {
  // The vak_ token skips cloudAuthHeaders' org-ID fetch, so the single
  // mocked fetch call is the endpoint under test. Each describe scopes its
  // own env save/restore around this.
  const TOKEN = "vak_test_token";
  let savedCloudUrl: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedCloudUrl = process.env.CADET_CLOUD_URL;
    savedEnv = process.env.CADET_ENVIRONMENT;
    process.env.CADET_CLOUD_URL = CLOUD_URL;
    delete process.env.CADET_ENVIRONMENT;
  });

  afterEach(() => {
    if (savedCloudUrl === undefined) {
      delete process.env.CADET_CLOUD_URL;
    } else {
      process.env.CADET_CLOUD_URL = savedCloudUrl;
    }
    if (savedEnv === undefined) {
      delete process.env.CADET_ENVIRONMENT;
    } else {
      process.env.CADET_ENVIRONMENT = savedEnv;
    }
  });

  return TOKEN;
}

describe("fetchCloudAssistants reads the chooser's list union", () => {
  const TOKEN = usePlatformUrl();

  test("a selection body maps every listed row — extra choice fields drop", async () => {
    mockFetchJson({
      status: "selection",
      assistants: [
        {
          id: "00000000-0000-7000-8000-000000000007",
          name: "Cadet 1",
          avatar_url: null,
          created: "2026-01-01T00:00:00.000Z",
          remote: "cloud",
        },
        {
          id: "00000000-0000-7000-8000-000000000008",
          name: "Cadet 2",
          avatar_url: null,
          created: "2026-01-02T00:00:00.000Z",
          remote: "cloud",
        },
      ],
    });
    expect(await fetchCloudAssistants(TOKEN)).toEqual([
      {
        id: "00000000-0000-7000-8000-000000000007",
        name: "Cadet 1",
        status: "active",
      },
      {
        id: "00000000-0000-7000-8000-000000000008",
        name: "Cadet 2",
        status: "active",
      },
    ]);
  });

  test("the empty arm is an empty list", async () => {
    mockFetchJson({ status: "empty" });
    expect(await fetchCloudAssistants(TOKEN)).toEqual([]);
  });

  test("an unparseable body is a non-fatal empty list", async () => {
    mockFetchJson({ detail: "not a list" });
    expect(await fetchCloudAssistants(TOKEN)).toEqual([]);
  });

  test("a non-ok response is a non-fatal empty list", async () => {
    mockFetchJson({ detail: "boom" }, 500);
    expect(await fetchCloudAssistants(TOKEN)).toEqual([]);
  });
});
