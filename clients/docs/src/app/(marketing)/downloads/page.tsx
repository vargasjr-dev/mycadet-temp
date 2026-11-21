import type { Metadata } from "next";

import DownloadsGrid from "@/components/downloads-grid";

import "./downloads.css";

export const metadata: Metadata = {
  title: "Downloads | Cadet",
  description:
    "Download Cadet for Mac, Windows, and Terminal — every desktop app in one place, ready to run on your own machine.",
};

// Ported from mycadet-cloud's app/(marketing)/downloads/page.tsx so the
// docs app can serve the marketing frontend. Statically rendered: the
// per-visitor bit (user-agent card ordering) lives in the DownloadsGrid
// client component, so the HTML isn't rendered per request.
export default function Downloads() {
  return (
    <main style={{ flex: 1, display: "flex", flexDirection: "column" }}>
      <section className="dl-section">
        <h1 style={{ fontSize: 48, letterSpacing: -1.5, textAlign: "center" }}>
          Your assistant, everywhere
        </h1>
        <p className="dl-sub">
          Every cadet app is still in training — for now, run the whole stack
          locally from your terminal.
        </p>

        <DownloadsGrid />

        <p className="dl-footnote">
          Coming from Vellum?{" "}
          <a href="/account/migrate/start">Migrate to Cadet here</a>.
        </p>
      </section>
    </main>
  );
}
