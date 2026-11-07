import { describe, expect, test } from "bun:test";

import { ROUTES as trustRuleRoutes } from "../http/routes/trust-rules.js";

/**
 * All trust-rule routes use scoped settings authorization. The fused ROUTES
 * array is the single declaration — the router generates the assistant-
 * scoped mirrors (same auth/scope) from the `scoped` flag, so the flat
 * entries pin both spellings.
 */
describe("trust rule route authorization", () => {
  test("all trust rule routes use scoped settings authorization", () => {
    expect(trustRuleRoutes).toHaveLength(6);

    for (const route of trustRuleRoutes) {
      expect(route.auth).toBe("edge-scoped");
      expect(route.scoped).toBe(true);

      const expectedScope =
        route.operationId === "trustRulesList"
          ? "settings.read"
          : "settings.write";
      expect(route.scope).toBe(expectedScope);
    }
  });
});
