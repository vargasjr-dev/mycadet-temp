import { describe, expect, test } from "bun:test";

import { platformOriginFromDevUrl } from "./dev-electron-local-web";

describe("platformOriginFromDevUrl", () => {
  test("uses the remote origin without the renderer path", () => {
    expect(
      platformOriginFromDevUrl("https://dev.mycadet.ai/assistant"),
    ).toBe("https://dev.mycadet.ai");
  });

  test("rejects URLs that cannot serve the platform API", () => {
    expect(() => platformOriginFromDevUrl("file:///tmp/assistant")).toThrow(
      "CADET_DEV_URL must use http or https",
    );
  });
});
