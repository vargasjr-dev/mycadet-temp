import type { Metadata } from "next";
import { PluginsExplorer } from "@/components/plugins-explorer";
import { loadCatalog } from "@/lib/plugins-catalog";

export const metadata: Metadata = {
  title: "Plugins — Cadet",
  description: "Give your Cadet superpowers — browse the plugin marketplace.",
};

// Catalog changes surface within five minutes — the fetch itself rides the
// data cache with the same window.
export const revalidate = 300;

export default async function Plugins() {
  const catalog = await loadCatalog();
  return (
    <main className="plugins-page">
      <section className="plugins-hero">
        <h1>
          Give your Cadet <em>Superpowers</em>
        </h1>
        <p>
          Install skills, tools and integrations into your assistant from a rich
          marketplace of plugins.
        </p>
      </section>
      {catalog === null ? (
        <section className="plugins-hero">
          <p>
            The plugin catalog is temporarily unavailable.{" "}
            <a href="/downloads">Download Cadet</a> or read the{" "}
            <a href="/docs">docs</a> in the meantime.
          </p>
        </section>
      ) : (
        <PluginsExplorer plugins={catalog} />
      )}
    </main>
  );
}
