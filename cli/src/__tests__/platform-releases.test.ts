import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  fetchLatestVersion,
  fetchReleases,
  resolveImageRefs,
  resolveOwnImageRefs,
} from "../lib/platform-releases.js";
import { dockerhubImages } from "../lib/docker.js";
import { isDevVersion, isStagingVersion } from "../lib/version-compat.js";

const originalFetch = globalThis.fetch;

function mockFetchJson(body: unknown, status = 200) {
  const fetchMock = mock(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

function mockFetchError() {
  globalThis.fetch = mock(async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  process.env.CADET_PLATFORM_URL = "https://platform.test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CADET_PLATFORM_URL;
});

const RELEASE = {
  version: "0.7.0",
  assistant_image_ref: "gcr.io/cadet/assistant@sha256:aaa",
  gateway_image_ref: "gcr.io/cadet/gateway@sha256:bbb",
  credential_executor_image_ref: "gcr.io/cadet/ces@sha256:ccc",
};

describe("fetchReleases", () => {
  test("defaults to stable=true and returns the list", async () => {
    const fetchMock = mockFetchJson([RELEASE]);
    const releases = await fetchReleases();
    expect(releases).toEqual([RELEASE]);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/v1/releases/?stable=true");
    expect(url).toContain("limit=100");
  });

  test("passes the channel param when given", async () => {
    const fetchMock = mockFetchJson([RELEASE]);
    await fetchReleases({ channel: "preview" });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/v1/releases/?channel=preview");
    expect(url).toContain("limit=100");
  });

  test("uses the platformUrl override over the resolved default", async () => {
    const fetchMock = mockFetchJson([RELEASE]);
    await fetchReleases({ platformUrl: "https://other-platform.test" });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("https://other-platform.test/v1/releases/");
  });

  test("returns null on non-OK response", async () => {
    mockFetchJson({ detail: "nope" }, 500);
    expect(await fetchReleases()).toBeNull();
  });

  test("returns null on network error", async () => {
    mockFetchError();
    expect(await fetchReleases()).toBeNull();
  });
});

describe("resolveImageRefs", () => {
  test("released CLI resolves un-suffixed repos tagged with the target version", () => {
    const tags = resolveImageRefs("v0.12.6", "0.12.6");
    expect(tags.assistant).toBe("mycadet/mycadet-assistant:v0.12.6");
    expect(tags.gateway).toBe("mycadet/mycadet-gateway:v0.12.6");
    expect(tags["credential-executor"]).toBe(
      "mycadet/mycadet-credential-executor:v0.12.6",
    );
  });

  test("dev CLI resolves -dev-suffixed repos", () => {
    const tags = resolveImageRefs(
      "v0.12.6-dev.202610081023.3a27b77",
      "0.12.6-dev.202610081023.3a27b77",
    );
    expect(tags.assistant).toBe(
      "mycadet/mycadet-assistant-dev:v0.12.6-dev.202610081023.3a27b77",
    );
    expect(tags.gateway).toBe(
      "mycadet/mycadet-gateway-dev:v0.12.6-dev.202610081023.3a27b77",
    );
    expect(tags["credential-executor"]).toBe(
      "mycadet/mycadet-credential-executor-dev:v0.12.6-dev.202610081023.3a27b77",
    );
  });

  test("repo suffix follows the CLI version, tag follows the target", () => {
    const tags = resolveImageRefs("v0.12.5", "0.12.6-dev.202610081023.3a27b77");
    expect(tags.assistant).toBe("mycadet/mycadet-assistant-dev:v0.12.5");
  });

  test("does not consult the network", async () => {
    mockFetchError();
    const tags = resolveImageRefs("v0.12.6", "0.12.6");
    expect(tags.assistant).toContain(":v0.12.6");
  });

  test("normalizes the v-prefix on the tag", () => {
    const withoutPrefix = resolveImageRefs("0.12.6", "0.12.6");
    const withPrefix = resolveImageRefs("v0.12.6", "0.12.6");
    expect(withoutPrefix.assistant).toBe(withPrefix.assistant);
  });
});

describe("resolveOwnImageRefs", () => {
  test("uses the CLI's own version for both tag and repo suffix", () => {
    const tags = resolveOwnImageRefs("0.12.6-dev.202610081023.3a27b77");
    expect(tags.assistant).toBe(
      "mycadet/mycadet-assistant-dev:v0.12.6-dev.202610081023.3a27b77",
    );
  });
});

describe("dockerhubImages", () => {
  test("dev versions get -dev repos", () => {
    const images = dockerhubImages("0.12.6-dev.202610081023.3a27b77");
    expect(images.assistant).toBe("mycadet/mycadet-assistant-dev");
    expect(images.gateway).toBe("mycadet/mycadet-gateway-dev");
    expect(images["credential-executor"]).toBe(
      "mycadet/mycadet-credential-executor-dev",
    );
  });

  test("stable versions get un-suffixed repos", () => {
    const images = dockerhubImages("0.12.6");
    expect(images.assistant).toBe("mycadet/mycadet-assistant");
    expect(images.gateway).toBe("mycadet/mycadet-gateway");
    expect(images["credential-executor"]).toBe(
      "mycadet/mycadet-credential-executor",
    );
  });
});

describe("version-shape helpers", () => {
  test("isDevVersion matches dev-release versions only", () => {
    expect(isDevVersion("0.12.6-dev.202610081023.3a27b77")).toBe(true);
    expect(isDevVersion("v0.12.6-dev.202610081023.3a27b77")).toBe(true);
    expect(isDevVersion("0.12.6")).toBe(false);
    expect(isDevVersion("0.12.6-staging.3")).toBe(false);
  });

  test("isStagingVersion matches staging versions only", () => {
    expect(isStagingVersion("0.6.0-staging.3")).toBe(true);
    expect(isStagingVersion("0.6.0")).toBe(false);
    expect(isStagingVersion("0.12.6-dev.202610081023.3a27b77")).toBe(false);
  });
});

describe("fetchLatestVersion", () => {
  test("defaults to the stable channel", async () => {
    const fetchMock = mockFetchJson([RELEASE]);
    const version = await fetchLatestVersion();
    expect(version).toBe("0.7.0");
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("stable=true");
    expect(url).not.toContain("channel=");
  });

  test("requests the preview channel when asked", async () => {
    const preview = { ...RELEASE, version: "0.8.0-preview.3" };
    const fetchMock = mockFetchJson([preview]);
    const version = await fetchLatestVersion("preview");
    expect(version).toBe("0.8.0-preview.3");
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("channel=preview");
  });

  test("returns null when the channel has no releases", async () => {
    mockFetchJson([]);
    expect(await fetchLatestVersion("preview")).toBeNull();
  });
});
