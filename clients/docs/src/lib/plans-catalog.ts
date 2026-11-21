// The pricing page's data loader. Plan naming, pricing, and copy live on
// the cloud side (served by the cloud-api's public /plans route through
// the web app's /api proxy) — the source repository never carries price
// values or product metadata, so the page fetches the catalog before
// rendering and degrades to the honest unavailable state when the API is
// down.

import { PUBLIC_API_BASE } from "@/lib/plugins-catalog";

export type PlanVariant = "infra" | "usage" | "infra_usage";

export interface PlanSize {
  plan: string;
  name: Record<PlanVariant, string>;
  blurb: Record<PlanVariant, string>;
  variants: Record<PlanVariant, number>;
  machineSpecs: [string, string];
  usageLine: string;
  cta: string;
  color: string;
  featured?: boolean;
}

export interface PlansCatalog {
  plans: PlanSize[];
  variantOrder: PlanVariant[];
  variantLabels: Record<PlanVariant, string>;
}

function isPlanVariant(value: unknown): value is PlanVariant {
  return value === "infra" || value === "usage" || value === "infra_usage";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlanSize(row: unknown): row is PlanSize {
  if (!isRecord(row)) {return false;}
  if (typeof row.plan !== "string") {return false;}
  if (!isRecord(row.variants)) {return false;}
  return (
    typeof row.variants.infra === "number" &&
    typeof row.variants.usage === "number" &&
    typeof row.variants.infra_usage === "number"
  );
}

function catalogFromResponse(data: unknown): PlansCatalog | null {
  if (!isRecord(data) || !Array.isArray(data.plans)) {return null;}
  const plans = data.plans.filter(isPlanSize);
  if (plans.length === 0) {return null;}
  const variantOrder: PlanVariant[] = Array.isArray(data.variantOrder)
    ? data.variantOrder.filter(isPlanVariant)
    : ["infra", "usage", "infra_usage"];
  const labels = isRecord(data.variantLabels) ? data.variantLabels : {};
  const variantLabels = {
    infra: typeof labels.infra === "string" ? labels.infra : "Infra only",
    usage: typeof labels.usage === "string" ? labels.usage : "Usage only",
    infra_usage:
      typeof labels.infra_usage === "string"
        ? labels.infra_usage
        : "Usage + infra",
  };
  return { plans, variantOrder, variantLabels };
}

export async function loadPlansCatalog(): Promise<PlansCatalog | null> {
  try {
    const res = await fetch(`${PUBLIC_API_BASE}/plans`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) {
      console.error(`[pricing] plans fetch failed: HTTP ${res.status}`);
      return null;
    }
    return catalogFromResponse(await res.json());
  } catch (error) {
    console.error("[pricing] plans fetch threw:", error);
    return null;
  }
}
