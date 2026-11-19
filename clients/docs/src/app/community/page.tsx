import type { Metadata } from "next";

import { createMetadata } from "@/lib/metadata";

const DISCORD_URL = "https://discord.gg/ZABd9V2zM8";
const SIGNUP_URL = "https://www.mycadet.ai/account/signup";

export const metadata: Metadata = createMetadata({
  title: "Community - Cadet",
  description:
    "Join the Cadet community — connect with others, share ideas, and discover what your assistant can become.",
  path: "/community",
});

export default function CommunityPage() {
  return (
    <main className="min-h-screen bg-white text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
      {/* Hero */}
      <section className="border-b border-zinc-100 px-6 py-20 text-center dark:border-zinc-900">
        <div className="mx-auto max-w-3xl">
          <p className="mb-3 text-xs font-semibold tracking-widest text-zinc-400 uppercase">
            Community
          </p>
          <h1 className="mb-4 text-4xl font-bold tracking-tight sm:text-5xl">
            Meet the community
          </h1>
          <p className="mb-8 text-lg text-zinc-500 dark:text-zinc-400">
            See how people are raising their assistants. Share what&apos;s
            working, ask what you&apos;re stuck on, and find out what yours
            could become.
          </p>
          <a
            href={DISCORD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-lg bg-zinc-900 px-6 py-3 text-sm font-semibold text-white no-underline transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            JOIN DISCORD
          </a>
        </div>
      </section>

      {/* Welcome */}
      <section className="border-b border-zinc-100 px-6 py-16 text-center dark:border-zinc-900">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-2 text-3xl font-bold">Welcome!</h2>
          <p className="mb-4 text-2xl text-zinc-500 dark:text-zinc-400">
            Glad you&apos;re here.
          </p>
          <p className="text-zinc-600 dark:text-zinc-400">
            The Cadet community is where owners compare setups, show off what
            their assistants automated this week, and get unstuck fast — usually
            from someone who hit the same wall yesterday. Bring a question,
            leave a screenshot.
          </p>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="border-t border-zinc-100 px-6 py-20 text-center dark:border-zinc-900">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-6 text-3xl font-bold tracking-tight sm:text-4xl">
            The personal AI you were promised
          </h2>
          <a
            href={SIGNUP_URL}
            className="inline-flex items-center rounded-lg bg-zinc-900 px-6 py-3 text-sm font-semibold text-white no-underline transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Get Started →
          </a>
        </div>
      </section>
    </main>
  );
}
