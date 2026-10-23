import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  fetchLatestVersion,
  fetchReleases,
  resolveImageRefs,
  resolveOwnImageRefs,
} from "../lib/cloud-releases.js";
import { dockerhubImages } from "../lib/docker.js";
import {
  isDevVersion,
  isLocalVersion,
  isStagingVersion,
} from "../lib/version-compat.js";

import { CADET_GITHUB_REPOSITORY } from "@mycadet/shared";

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
  process.env.CADET_CLOUD_URL = "https://platform.test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CADET_CLOUD_URL;
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

  test("uses the cloudUrl override over the resolved default", async () => {
    const fetchMock = mockFetchJson([RELEASE]);
    await fetchReleases({ cloudUrl: "https://other-platform.test" });
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
  test("released CLI resolves un-suffixed repos tagged with the bare version", () => {
    const tags = resolveImageRefs("v0.12.6", "0.12.6");
    expect(tags.assistant).toBe("mycadet/mycadet-assistant:0.12.6");
    expect(tags.gateway).toBe("mycadet/mycadet-gateway:0.12.6");
    expect(tags["credential-executor"]).toBe(
      "mycadet/mycadet-credential-executor:0.12.6",
    );
  });

  test("dev CLI resolves -dev-suffixed repos", () => {
    const tags = resolveImageRefs(
      "v0.12.6-dev.202610081023.3a27b77",
      "0.12.6-dev.202610081023.3a27b77",
    );
    expect(tags.assistant).toBe(
      "mycadet/mycadet-assistant-dev:0.12.6-dev.202610081023.3a27b77",
    );
    expect(tags.gateway).toBe(
      "mycadet/mycadet-gateway-dev:0.12.6-dev.202610081023.3a27b77",
    );
    expect(tags["credential-executor"]).toBe(
      "mycadet/mycadet-credential-executor-dev:0.12.6-dev.202610081023.3a27b77",
    );
  });

  test("repo suffix follows the CLI version, tag follows the target", () => {
    const tags = resolveImageRefs("v0.12.5", "0.12.6-dev.202610081023.3a27b77");
    expect(tags.assistant).toBe("mycadet/mycadet-assistant-dev:0.12.5");
  });

  test("does not consult the network", async () => {
    mockFetchError();
    const tags = resolveImageRefs("v0.12.6", "0.12.6");
    expect(tags.assistant).toContain(":0.12.6");
  });

  test("normalizes the v-prefix off the tag", () => {
    const withoutPrefix = resolveImageRefs("0.12.6", "0.12.6");
    const withPrefix = resolveImageRefs("v0.12.6", "0.12.6");
    expect(withoutPrefix.assistant).toBe("mycadet/mycadet-assistant:0.12.6");
    expect(withPrefix.assistant).toBe(withoutPrefix.assistant);
  });
});

describe("resolveOwnImageRefs", () => {
  test("uses the CLI's own version for both tag and repo suffix", () => {
    const tags = resolveOwnImageRefs("0.12.6-dev.202610081023.3a27b77");
    expect(tags.assistant).toBe(
      "mycadet/mycadet-assistant-dev:0.12.6-dev.202610081023.3a27b77",
    );
  });

  test("falls back to the literal latest tag when the CLI version is unknown", () => {
    const tags = resolveOwnImageRefs("");
    expect(tags.assistant).toBe("mycadet/mycadet-assistant:latest");
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

  test("isLocalVersion matches local builds only", () => {
    expect(isLocalVersion("0.12.6-local.42")).toBe(true);
    expect(isLocalVersion("v0.12.6-local.42")).toBe(true);
    expect(isLocalVersion("0.12.6")).toBe(false);
    expect(isLocalVersion("0.12.6-dev.202610081023.3a27b77")).toBe(false);
  });
});

describe("fetchLatestVersion", () => {
  test("requests stable releases", async () => {
    const fetchMock = mockFetchJson([RELEASE]);
    const version = await fetchLatestVersion();
    expect(version).toBe("0.7.0");
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("stable=true");
    expect(url).not.toContain("channel=");
  });
});

describe("stable release fallback", () => {
  function withGitHubFallback(cloudBody: unknown, cloudStatus = 200) {
    const fetchMock = mock(async (url: RequestInfo | URL) => {
      if (String(url).startsWith("https://api.github.com/")) {
        return Response.json({
          tag_name: "v0.12.11",
          draft: false,
          prerelease: false,
        });
      }
      return Response.json(cloudBody, { status: cloudStatus });
    });
    globalThis.fetch = Object.assign(fetchMock, {
      preconnect: originalFetch.preconnect,
    });
    return fetchMock;
  }

  test.each([
    [404, { detail: "not found" }],
    [503, { detail: "unavailable" }],
    [200, []],
    [200, { results: [] }],
    [200, [{ version: "not-a-version" }]],
    [200, [{ version: "0.13.0-preview.1" }]],
    [200, [{ version: "0.13.0", is_stable: false }]],
  ])("falls back for cloud status %s and body %j", async (status, body) => {
    const fetchMock = withGitHubFallback(body, status);
    expect(await fetchLatestVersion()).toBe("0.12.11");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      `https://api.github.com/repos/${CADET_GITHUB_REPOSITORY}/releases/latest`,
    );
  });

  test("falls back when the cloud request throws", async () => {
    const fetchMock = withGitHubFallback([]);
    globalThis.fetch = Object.assign(
      mock(async (url: RequestInfo | URL) => {
        if (!String(url).startsWith("https://api.github.com/")) {
          throw new TypeError("fetch failed");
        }
        return fetchMock(url);
      }),
      { preconnect: originalFetch.preconnect },
    );
    expect(await fetchLatestVersion()).toBe("0.12.11");
  });

  test("does not contact GitHub when cloud discovery succeeds", async () => {
    const fetchMock = withGitHubFallback([RELEASE]);
    expect(await fetchLatestVersion()).toBe(RELEASE.version);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    { tag_name: "v0.13.0", draft: true, prerelease: false },
    { tag_name: "v0.13.0", draft: false, prerelease: true },
    { tag_name: "v0.13.0-preview.1", draft: false, prerelease: false },
    { tag_name: "not-a-version", draft: false, prerelease: false },
    { tag_name: "v0.13.0" },
  ])("rejects invalid GitHub stable release %j", async (body) => {
    mockFetchJson(body);
    expect(await fetchLatestVersion()).toBeNull();
  });

  test("returns null when both services fail", async () => {
    mockFetchError();
    expect(await fetchLatestVersion()).toBeNull();
    mockFetchJson({ message: "rate limited" }, 403);
    expect(await fetchLatestVersion()).toBeNull();
  });
});
