import type { Metadata } from "next";

import { CharacterPool } from "@/components/character-avalanche";

import { createMetadata } from "@/lib/metadata";

import "./community.css";

const DISCORD_URL = "https://discord.gg/ZABd9V2zM8";
const SIGNUP_URL = "/account/signup";

export const metadata: Metadata = createMetadata({
  title: "Community - Cadet",
  description:
    "Join the Cadet community — connect with others, share ideas, and discover what your assistant can become.",
  path: "/community",
});

/* The cast greets you from the bottom of the first viewport — same lines
 * the old copy section carried, now in speech bubbles over the character
 * pool (the cloud landing's avalanche, pool bands only). */
const GREETINGS = [
  { line: "Welcome!", left: "16%", top: "12%", delay: "0s" },
  { line: "Glad you're here!", left: "44%", top: "2%", delay: "0.9s" },
  { line: "Join us!", left: "72%", top: "14%", delay: "1.7s" },
];

export default function CommunityPage() {
  return (
    <main className="community">
      {/* Hero */}
      <section className="community-hero">
        <div className="community-hero-copy">
          <p className="community-eyebrow">Community</p>
          <h1>Meet the community</h1>
          <p className="community-sub">
            See how people are raising their assistants. Share what&apos;s
            working, ask what you&apos;re stuck on, and find out what yours
            could become.
          </p>
          <a
            href={DISCORD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-discord btn-lg"
          >
            JOIN DISCORD
          </a>
        </div>

        {/* The cast pools along the fold and says hi */}
        <div className="community-pool">
          <CharacterPool />
          {GREETINGS.map((g) => (
            <span
              key={g.line}
              className="community-bubble"
              style={{
                left: g.left,
                top: g.top,
                animationDelay: g.delay,
              }}
            >
              {g.line}
            </span>
          ))}
        </div>
      </section>

      {/* Welcome copy */}
      <section className="community-body">
        <p>
          The Cadet community is where owners compare setups, show off what
          their assistants automated this week, and get unstuck fast — usually
          from someone who hit the same wall yesterday. Bring a question,
          leave a screenshot.
        </p>
      </section>

      {/* Closing CTA */}
      <section className="community-cta">
        <h2>The personal AI you were promised</h2>
        <a href={SIGNUP_URL} className="btn btn-lg">
          Get Started →
        </a>
      </section>
    </main>
  );
}
