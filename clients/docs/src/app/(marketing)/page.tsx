import Silhouette from "@/components/silhouette";
import CharacterAvalanche from "@/components/character-avalanche";
import LandingChapters from "@/components/landing-chapters";
import { PreviewTitle } from "@/components/preview-title";

import { createMetadata } from "@/lib/metadata";

import "./landing.css";
import "./landing-wash.css";

export const metadata = createMetadata({
  title: "Cadet | Your personal digital assistant",
  description:
    "Cadet is the personal agent that handles your email, projects, routines, and business — 100% yours, private and secure, on your own machine.",
  path: "/",
});

// Statically rendered: the hero is 99% identical for every visitor — the
// session-aware CTA stays in the cloud until auth moves over, so a static
// "Hatch Yours" sits in its slot for now.
export default function Home() {
  return (
    <>
      <main className="landing">
        <CharacterAvalanche />
        <section className="landing-hero">
          <div className="hero-copy">
            <PreviewTitle />
            <p className="hero-tagline">
              The personal agent that handles your <Silhouette />
            </p>
            <a className="btn btn-lg hero-cta" href="/account/signup">
              Hatch Yours
            </a>
          </div>
        </section>
      </main>
      {/* Sibling of main on purpose: main.landing's flex hero needs its
          min-height to fill the first viewport, and a 400vh child inside
          would collapse it. The chapters section pins itself. */}
      <LandingChapters />
    </>
  );
}
