import type { Metadata } from "next";
import { PricingCards } from "@/components/pricing-cards";
import { loadPlansCatalog } from "@/lib/plans-catalog";

export const metadata: Metadata = {
  title: "Pricing — Cadet",
  description: "Plans for hosting your personal Cadet.",
};

// Plan data arrives from the cloud's public /v1/plans route (the source
// repository carries no price values or product metadata — the cloud side
// stays fully in control of it). Catalog changes surface within five
// minutes — the fetch rides the data cache with the same window.
export const revalidate = 300;

export default async function Pricing() {
  const catalog = await loadPlansCatalog();
  return (
    <main className="pricing-page">
      <section className="plugins-hero">
        <h1>
          Pricing for your <em>Cadet</em>
        </h1>
        <p>
          One assistant, three sizes. Pick the computer and usage that fit —
          change any time.
        </p>
      </section>
      {catalog === null ? (
        <section className="plugins-hero">
          <p>
            Plans are temporarily unavailable.{" "}
            <a href="/downloads">Download Cadet</a> or read the{" "}
            <a href="/docs">docs</a> in the meantime.
          </p>
        </section>
      ) : (
        <section className="pricing-body">
          <PricingCards catalog={catalog} />
        </section>
      )}
    </main>
  );
}
