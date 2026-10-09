/**
 * Tests that the auto-redeploy path deploys the app's *effective* HTML
 * (compiled dist/index.html) rather than the empty `htmlDefinition`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { getAppDirPath, getAppsDir } from "../apps/app-store.js";
import { seedApp } from "./helpers/seed-app.js";

// ── Mocks ───────────────────────────────────────────────────────────────

let mockPublishedPage: {
  id: string;
  projectSlug?: string;
  htmlHash: string;
} | null = null;
const updatePublishedPageSpy = mock(() => {});

mock.module("../apps/published-pages-store.js", () => ({
  getActivePublishedPageByAppId: () => mockPublishedPage,
  updatePublishedPage: updatePublishedPageSpy,
}));

const deploySpy = mock(async (_args: { html: string; name: string }) => ({
  deploymentId: "dep-1",
  url: "https://example.vercel.app",
}));

mock.module("../services/vercel-deploy.js", () => ({
  deployHtmlToVercel: deploySpy,
}));

// credentialBroker.serverUse invokes execute(token) and reports success.
mock.module("../tools/credentials/broker.js", () => ({
  credentialBroker: {
    serverUse: async ({
      execute,
    }: {
      execute: (token: string) => Promise<unknown>;
    }) => {
      await execute("test-token");
      return { success: true };
    },
  },
}));

const { updatePublishedAppDeployment } =
  await import("../services/published-app-updater.js");

/** Seeds the real app row and writes its compiled dist/index.html. */
function seedAppWithDist(distHtml: string | null) {
  seedApp({ id: "app-1", name: "App", schemaJson: "{}" });
  const appDir = getAppDirPath("app-1");
  if (distHtml === null) {
    rmSync(join(appDir, "dist"), { recursive: true, force: true });
    return;
  }
  mkdirSync(join(appDir, "dist"), { recursive: true });
  writeFileSync(join(appDir, "dist", "index.html"), distHtml);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("updatePublishedAppDeployment", () => {
  beforeEach(() => {
    mockPublishedPage = { id: "pp-1", projectSlug: "slug", htmlHash: "old" };
    deploySpy.mockClear();
    updatePublishedPageSpy.mockClear();
  });

  afterEach(() => {
    rmSync(getAppsDir(), { recursive: true, force: true });
  });

  test("deploys the resolved effective HTML, not the empty htmlDefinition", async () => {
    // htmlDefinition is "" (as it is for every app); the real content comes
    // from the compiled dist/index.html the store resolves.
    seedAppWithDist("<html><body>real app</body></html>");

    await updatePublishedAppDeployment("app-1");

    expect(deploySpy).toHaveBeenCalledTimes(1);
    expect(deploySpy.mock.calls[0][0].html).toBe(
      "<html><body>real app</body></html>",
    );
  });

  test("skips deploy when the app has no compiled output", async () => {
    seedAppWithDist(null);

    await updatePublishedAppDeployment("app-1");

    expect(deploySpy).not.toHaveBeenCalled();
  });

  test("skips deploy when content hash is unchanged", async () => {
    const html = "<html>same</html>";
    seedAppWithDist(html);
    const { createHash } = await import("node:crypto");
    mockPublishedPage = {
      id: "pp-1",
      htmlHash: createHash("sha256").update(html).digest("hex"),
    };

    await updatePublishedAppDeployment("app-1");

    expect(deploySpy).not.toHaveBeenCalled();
  });

  test("skips deploy when the app has no active published page", async () => {
    mockPublishedPage = null;
    seedAppWithDist("<html>x</html>");

    await updatePublishedAppDeployment("app-1");

    expect(deploySpy).not.toHaveBeenCalled();
  });
});
