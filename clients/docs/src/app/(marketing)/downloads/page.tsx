import type { Metadata } from "next";

import DownloadsGrid from "@/components/downloads-grid";

import "./downloads.css";

export const metadata: Metadata = {
  title: "Downloads | Cadet",
  description:
    "Download Cadet for Mac, Windows, Linux, and Terminal — every desktop app in one place, ready to run on your own machine.",
};

// Ported from mycadet-cloud's app/(marketing)/downloads/page.tsx so the
// docs app can serve the marketing frontend. Statically rendered: the
// per-visitor bit (user-agent card ordering) lives in the DownloadsGrid
// client component, so the HTML isn't rendered per request.
export default function Downloads() {
  return (
    <main style={{ flex: 1, display: "flex", flexDirection: "column" }}>
      <section className="dl-section">
        <h1 className="dl-title">Your assistant, everywhere</h1>
        <DownloadsGrid />

        <p className="dl-footnote">
          Coming from Vellum?{" "}
          <a href="/account/migrate/start">Migrate to Cadet here</a>.
        </p>
      </section>
    </main>
  );
}
