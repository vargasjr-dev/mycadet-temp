import { describe, expect, test } from "bun:test";

import { CALL_SITE_DEFAULTS } from "../../../config/call-site-defaults.js";
import { LLMCallSiteEnum, LLMSchema } from "../../../config/schemas/llm.js";
import {
  buildCallSiteCatalog,
  callSiteCatalogResponseSchema,
  ROUTES,
} from "../llm-call-sites-routes.js";

const route = ROUTES.find((r) => r.operationId === "llm_call_sites_list")!;

async function readCatalog() {
  return callSiteCatalogResponseSchema.parse(await route.handler({}));
}

describe("llm-call-sites-routes", () => {
  test("route is defined with correct method and endpoint", () => {
    expect(route).toBeDefined();
    expect(route.method).toBe("GET");
    expect(route.endpoint).toBe("config/llm/call-sites");
  });

  test("response has domains and callSites arrays", async () => {
    const result = await readCatalog();
    expect(Array.isArray(result.domains)).toBe(true);
    expect(Array.isArray(result.callSites)).toBe(true);
  });

  test("all call site IDs match LLMCallSiteEnum", async () => {
    const result = await readCatalog();
    const validIds = new Set<string>(LLMCallSiteEnum.options);
    for (const site of result.callSites) {
      expect(validIds.has(site.id)).toBe(true);
      expect(site.displayName).toBeTruthy();
      expect(site.description).toBeTruthy();
    }
    expect(result.callSites.length).toBe(LLMCallSiteEnum.options.length);
  });

  test("all call site domain references match defined domains", async () => {
    const result = await readCatalog();
    const domainIds = new Set(result.domains.map((d) => d.id));
    for (const site of result.callSites) {
      expect(domainIds.has(site.domain)).toBe(true);
    }
  });

  test("defaultProfile is a non-empty string or undefined per call site", async () => {
    const result = await readCatalog();
    for (const site of result.callSites) {
      if (site.defaultProfile != null) {
        expect(typeof site.defaultProfile).toBe("string");
        expect(site.defaultProfile.length).toBeGreaterThan(0);
      }
    }
  });

  test("shippedDefaultProfile is the code-owned tier, unaffected by pins", async () => {
    const result = await readCatalog();
    for (const site of result.callSites) {
      expect(site.shippedDefaultProfile).toBe(
        CALL_SITE_DEFAULTS[LLMCallSiteEnum.parse(site.id)]?.profile ??
          "balanced",
      );
    }
  });

  test("profileless call sites report the balanced anchor tier", async () => {
    const result = await readCatalog();
    // Both omit `profile` in CALL_SITE_DEFAULTS and ride the resolver's
    // balanced anchor, so the catalog groups them under Balanced.
    for (const id of ["workflowLeaf", "vision"]) {
      const site = result.callSites.find((s) => s.id === id);
      expect(site?.shippedDefaultProfile).toBe("balanced");
    }
  });

  test("omits an unavailable managed-only shipped default under BYOK", () => {
    const managed = buildCallSiteCatalog(LLMSchema.parse({})).find(
      ({ id }) => id === "voiceEscalationJudge",
    );
    expect(managed?.defaultProfile).toBe("jev-managed");
    expect(managed?.shippedDefaultProfile).toBe("jev-managed");

    const byok = buildCallSiteCatalog(
      LLMSchema.parse({ default: { provider: "anthropic" } }),
    ).find(({ id }) => id === "voiceEscalationJudge");
    expect(byok?.defaultProfile).toBeUndefined();
    expect(byok?.shippedDefaultProfile).toBeUndefined();
  });

  test("domains have non-empty id and displayName", async () => {
    const result = await readCatalog();
    expect(result.domains.length).toBeGreaterThan(0);
    for (const domain of result.domains) {
      expect(domain.id).toBeTruthy();
      expect(domain.displayName).toBeTruthy();
    }
  });
});
