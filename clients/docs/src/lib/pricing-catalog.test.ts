/**
 * The /v1/plans loader and the legal-page markdown conversion. The loader
 * is the pricing page's only data path — these tests run it against a
 * stubbed fetch (no network) and pin the honest-degradation contract. The
 * legal tests pin the source-of-truth renames the closed #937 branch made
 * and the allowlist that guards the file read.
 */

import { readFileSync } from "node:fs";

import { afterAll, describe, expect, test } from "bun:test";

import { fetchLegalPageContent } from "@/lib/discover-docs-routes";
import { loadPlansCatalog } from "@/lib/plans-catalog";
import { PUBLIC_API_BASE } from "@/lib/plugins-catalog";

const REAL_FETCH = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = REAL_FETCH;
});

const CATALOG_BODY: unknown = {
  plans: [
    {
      plan: "mighty",
      name: { infra: "Mighty Computer", usage: "Mighty Usage", infra_usage: "Mighty Cadet" },
      blurb: { infra: "b", usage: "b", infra_usage: "b" },
      variants: { infra: 25, usage: 25, infra_usage: 50 },
      machineSpecs: ["Small computer · 1 vCPU / 2 GiB", "20 GB storage"],
      usageLine: "Modest model usage included",
      cta: "Power Up",
      color: "#4C9B50",
      featured: true,
    },
    {
      // A row that fails the shape check must not reach the page.
      plan: "junk",
    },
  ],
  variantOrder: ["infra", "usage", "infra_usage"],
  variantLabels: { infra: "Infra only", usage: "Usage only", infra_usage: "Usage + infra" },
};

describe("loadPlansCatalog", () => {
  test("fetches through the public /api proxy", async () => {
    let requested: string | undefined;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        requested = String(input);
        return new Response(JSON.stringify(CATALOG_BODY), { status: 200 });
      },
      { preconnect: () => {} },
    );
    const catalog = await loadPlansCatalog();
    expect(catalog).not.toBeNull();
    expect(requested).toBe(`${PUBLIC_API_BASE}/plans`);
  });

  test("parses the catalog body and drops junk rows", async () => {
    globalThis.fetch = Object.assign(
      async () => new Response(JSON.stringify(CATALOG_BODY), { status: 200 }),
      { preconnect: () => {} },
    );
    const catalog = await loadPlansCatalog();
    expect(catalog).not.toBeNull();
    expect(catalog?.plans).toHaveLength(1);
    expect(catalog?.plans[0]?.plan).toBe("mighty");
    expect(catalog?.plans[0]?.variants.infra_usage).toBe(50);
    expect(catalog?.variantLabels.infra).toBe("Infra only");
  });

  test("degrades to null on a non-200", async () => {
    globalThis.fetch = Object.assign(
      async () => new Response("no", { status: 503 }),
      { preconnect: () => {} },
    );
    expect(await loadPlansCatalog()).toBeNull();
  });
});

describe("legal pages as markdown", () => {
  test("the fetch reads only the allowlisted pages", () => {
    expect(fetchLegalPageContent("privacy-policy")).toContain("Privacy Policy");
    expect(fetchLegalPageContent("terms-of-use")).toContain("Terms of Service");
    expect(() => fetchLegalPageContent("../../package")).toThrow(/Unknown legal page/);
  });

  test("the Privacy Notice → Privacy Policy rename is complete", () => {
    const privacy = fetchLegalPageContent("privacy-policy");
    // The document's own name everywhere…
    expect(privacy).toContain("This Privacy Policy describes");
    expect(privacy).toContain("questions about this Privacy Policy");
    // …while the third-party providers' notices stay "privacy notice".
    expect(privacy).toContain("provider operates under its own privacy notice");
    expect(privacy).toContain("review each provider's privacy notice");
  });

  test("the pages render through the markdown component with a TOC", () => {
    const wrapper = readFileSync(
      "src/app/docs/(documentation)/privacy-policy/page.tsx",
      "utf8",
    );
    expect(wrapper).toContain("LegalMarkdown");
    expect(wrapper).toContain('title="Privacy Policy"');
    expect(readFileSync("src/app/docs/_components/legal-markdown.tsx", "utf8")).toContain(
      "TableOfContents",
    );
  });
});
