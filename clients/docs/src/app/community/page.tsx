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

// Sample wall — swap in real member quotes as they come in.
const TESTIMONIALS: Array<{
  name: string;
  badge: "MEMBER" | "MAKER" | "POWER USER";
  date: string;
  quote: string;
  reactions: Array<{ emoji: string; count: number }>;
}> = [
  {
    name: "Priya",
    badge: "POWER USER",
    date: "Jun 14, 2026",
    quote:
      "my cadet runs the morning digest, triages email, and texts me when a deploy breaks. i basically hired an intern that lives in a browser tab.",
    reactions: [
      { emoji: "🤯", count: 3 },
      { emoji: "🔥", count: 5 },
    ],
  },
  {
    name: "Marcus",
    badge: "MEMBER",
    date: "Apr 3, 2026",
    quote:
      "moved from a folder of cron scripts and a notes app to one assistant that actually remembers why I set each one.",
    reactions: [{ emoji: "💯", count: 100 }],
  },
  {
    name: "Lone",
    badge: "MAKER",
    date: "May 13, 2026",
    quote:
      "it built me a habit tracker app mid-conversation. not a mockup. a real app. with my name on it.",
    reactions: [
      { emoji: "⚡", count: 3 },
      { emoji: "🚀", count: 4 },
    ],
  },
  {
    name: "Sam",
    badge: "MEMBER",
    date: "May 28, 2026",
    quote:
      "the phone calls still get me. it called the dentist, rescheduled, and put it on my calendar before I finished my coffee.",
    reactions: [
      { emoji: "❤️", count: 12 },
      { emoji: "💯", count: 8 },
    ],
  },
  {
    name: "Dee",
    badge: "POWER USER",
    date: "May 25, 2026",
    quote:
      "trained mine to file Linear tickets the way our PM does. a 1000% improvement over my old reminders workflow.",
    reactions: [{ emoji: "🔥", count: 4 }],
  },
  {
    name: "Noah",
    badge: "MEMBER",
    date: "Mar 19, 2026",
    quote:
      "named mine Wexler and gave it an avatar. weirdly it feels less like software and more like a coworker.",
    reactions: [
      { emoji: "🎉", count: 5 },
      { emoji: "✨", count: 3 },
    ],
  },
  {
    name: "evan",
    badge: "MEMBER",
    date: "May 19, 2026",
    quote:
      "seriously love what you guys have built here. it's exactly what i dreamed a personal assistant would be.",
    reactions: [{ emoji: "❤️", count: 8 }],
  },
  {
    name: "anomaly",
    badge: "POWER USER",
    date: "May 23, 2026",
    quote:
      "mine feels closer to a chief of staff than an assistant. it remembers the context behind every request.",
    reactions: [
      { emoji: "👀", count: 2 },
      { emoji: "✨", count: 2 },
    ],
  },
];

const BADGE_STYLES: Record<string, string> = {
  MEMBER: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  MAKER: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  "POWER USER":
    "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
};

const AVATAR_STYLES = [
  "bg-emerald-200 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
  "bg-sky-200 text-sky-800 dark:bg-sky-900 dark:text-sky-200",
  "bg-amber-200 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  "bg-violet-200 text-violet-800 dark:bg-violet-900 dark:text-violet-200",
  "bg-rose-200 text-rose-800 dark:bg-rose-900 dark:text-rose-200",
  "bg-teal-200 text-teal-800 dark:bg-teal-900 dark:text-teal-200",
];

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

      {/* Testimonial wall */}
      <section className="px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-10 text-center text-3xl font-bold">
            From the community 🤍
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {TESTIMONIALS.map((t, i) => (
              <figure
                key={t.name}
                className="flex flex-col rounded-2xl border border-zinc-100 bg-zinc-50 p-5 dark:border-zinc-900 dark:bg-zinc-900"
              >
                <figcaption className="mb-3 flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold ${
                      AVATAR_STYLES[i % AVATAR_STYLES.length]
                    }`}
                  >
                    {t.name.charAt(0).toUpperCase()}
                  </span>
                  <span>
                    <span className="block text-sm font-semibold">
                      {t.name}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-zinc-400">
                      {t.date}
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${
                          BADGE_STYLES[t.badge]
                        }`}
                      >
                        {t.badge}
                      </span>
                    </span>
                  </span>
                </figcaption>
                <blockquote className="flex-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
                  {t.quote}
                </blockquote>
                <div className="mt-4 flex gap-3 text-xs text-zinc-400">
                  {t.reactions.map((r) => (
                    <span key={r.emoji} className="tabular-nums">
                      {r.emoji} {r.count}
                    </span>
                  ))}
                </div>
              </figure>
            ))}
          </div>
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
