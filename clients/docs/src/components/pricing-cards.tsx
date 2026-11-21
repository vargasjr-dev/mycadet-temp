"use client";

import { useState } from "react";
import type { PlanSize, PlanVariant, PlansCatalog } from "@/lib/plans-catalog";
import { routes } from "@/lib/routes";

// The plan cards for the public pricing page — the display half of the
// cloud app's PlanCards, fed entirely by the /v1/plans catalog (the source
// repository carries no price values). The variant toggle drives the
// per-variant name/blurb/price from the same fetched data.

// What the card's "Includes" list holds for a variant: machine specs only
// belong to plans that actually rent a machine. Mirrors the cloud's
// includesFor so the two pages read the same way.
function includesFor(size: PlanSize, variant: PlanVariant): string[] {
  if (variant === "usage") {return ["No dedicated machine", size.usageLine];}
  if (variant === "infra_usage") {return [...size.machineSpecs, size.usageLine];}
  return [...size.machineSpecs, "Usage billed separately"];
}

export function PricingCards({ catalog }: { catalog: PlansCatalog }) {
  const [variant, setVariant] = useState<PlanVariant>(
    catalog.variantOrder[0] ?? "infra",
  );

  return (
    <>
      <div className="pricing-pills" role="tablist" aria-label="Plan variant">
        {catalog.variantOrder.map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={option === variant}
            className={option === variant ? "plugin-pill on" : "plugin-pill"}
            onClick={() => setVariant(option)}
          >
            {catalog.variantLabels[option]}
          </button>
        ))}
      </div>
      <div className="pricing-grid">
        {catalog.plans.map((size) => (
          <div
            key={size.plan}
            className="pricing-card"
            style={size.featured ? { borderColor: size.color } : undefined}
          >
            <strong className="pricing-name">{size.name[variant]}</strong>
            <span className="pricing-blurb">{size.blurb[variant]}</span>
            <span className="pricing-price">
              <span className="pricing-amount">${size.variants[variant]}</span>
              <span className="pricing-period"> /month</span>
            </span>
            <div className="pricing-includes">
              <span className="pricing-includes-label">Includes:</span>
              {includesFor(size, variant).map((spec) => (
                <span key={spec} className="pricing-spec">
                  <span
                    className="pricing-dot"
                    style={{ background: size.color }}
                  />
                  {spec}
                </span>
              ))}
            </div>
            <a href={routes.signup} className="pricing-cta">
              {size.cta}
            </a>
          </div>
        ))}
      </div>
    </>
  );
}
