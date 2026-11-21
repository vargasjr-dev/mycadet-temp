"use client";

/**
 * The four-chapter scroll section (the Vellum-shaped scrollytelling block):
 * as the user scrolls, one tall pinned viewport walks through "I'm 100%
 * yours, forever" → "I remember what's important" → "I'm always available"
 * → "I'm private & secure". The headings stay stacked on the left (active
 * one dark, the rest faded), the background morphs between the chapter
 * colors, and each chapter's illustration plays on the right.
 *
 * The section is hidden behind the secret preview mode (lib/preview) while
 * it's being iterated on: regular visitors don't get any of it in their
 * HTML — seven consecutive clicks on the hero title mount it.
 *
 * One client component is all the landing page hydrates when unlocked — the
 * avalanche and hero above stay pure server-rendered CSS. Without JS the
 * section stays hidden entirely (it's the preview gate, not a content
 * fallback).
 *
 * The chapter copy is Cadet's voice (first person, like the hero); the
 * memory pills, personality dials, orbit, and vault art are drawn from
 * scratch to match the reference.
 */

import { useEffect, useRef, useState } from "react";
import { PREVIEW_EVENT, previewUnlocked } from "@/lib/preview";

const CHAPTERS = [
  {
    title: "I'm 100% yours, forever",
    copy: "You shape every aspect of me, from the way I talk to the way I work for you. I learn about you and your preferences to become truly yours over time.",
    color: "#e8792e",
  },
  {
    title: "I remember what's important",
    copy: "My memory is custom built to remember everything that matters to you. You, your life, people, preferences, and work are remembered across every conversation we have.",
    color: "#2fa39a",
  },
  {
    title: "I'm always available",
    copy: "I'm on 24/7 and can be reached on every device or browser you use. My same identity, memory, chats, and schedules are available anywhere you are.",
    color: "#9a6bd8",
  },
  {
    title: "I'm private & secure",
    copy: "My memory and credentials vault live locally on your machine — none of your data is accessible by us unless you've opted in. I ask for permission on tasks with security risks until you mark them as trusted, so you are always in control.",
    color: "#a89b1c",
  },
];

/* ── Chapter 1: the personality dials — five pills around a dashed line ── */

const DIALS = [
  { label: "Companion", x: 12, h: 64, above: false },
  { label: "Gen Z", x: 26, h: 124, above: false },
  { label: "Collaborative", x: 44, h: 82, above: true },
  { label: "Playful", x: 62, h: 36, above: false },
  { label: "Unfiltered", x: 82, h: 132, above: true },
];

function PersonalityDials({ on }: { on: boolean }) {
  return (
    <div className={`dials${on ? " on" : ""}`}>
      <div className="dials-line" />
      {DIALS.map((d, i) => (
        <div key={d.label} className="dial" style={{ left: `${d.x}%` }}>
          <span
            className={`dial-bar${d.above ? " up" : ""}`}
            style={{
              height: d.h,
              transitionDelay: `${i * 90}ms`,
              // once the spring-in settles, keep each bar gently
              // oscillating (vellum-style); per-bar phase + tempo keep
              // them from moving in lockstep
              animationDuration: `${(1.3 + ((i * 7) % 5) * 0.3).toFixed(2)}s`,
              animationDelay: `${760 + i * 90}ms`,
            }}
          />
          <span
            className={`dial-label${d.above ? " up" : ""}`}
            style={{ transitionDelay: `${i * 90 + 260}ms` }}
          >
            {d.label}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Chapter 2: the memory graph — nodes, a web of lines, and pills ── */

type Mem = { x: number; y: number; label?: string; big?: boolean };

const MEMS: Mem[] = [
  { x: 612, y: 140, label: "Serif fonts fan", big: true },
  { x: 656, y: 56, label: "Karaoke: never again" },
  { x: 895, y: 36, label: "Tea after dinner" },
  { x: 355, y: 158, label: "Sister lands Friday" },
  { x: 618, y: 196, label: "Window seat, always" },
  { x: 838, y: 262, label: "Demo env: staging" },
  { x: 642, y: 318, label: "Prefers Slack DMs" },
  { x: 300, y: 292, label: "Anniversary · Oct 3" },
  { x: 248, y: 348, label: "Big pitch Friday", big: true },
  { x: 772, y: 398, label: "Ghibli marathons" },
  { x: 836, y: 470, label: "Dog: Miso", big: true },
  { x: 452, y: 434, label: "Gym Tue & Thu, 7am" },
  { x: 498, y: 522, label: "Mom's birthday · May 12", big: true },
  { x: 182, y: 118 },
  { x: 88, y: 298 },
  { x: 120, y: 562 },
  { x: 300, y: 652 },
  { x: 604, y: 664 },
  { x: 762, y: 622 },
  { x: 898, y: 352 },
  { x: 58, y: 428 },
];

// A loose web: each node tied to a few neighbors, like the reference.
const EDGES: Array<[number, number]> = [
  [0, 1],
  [0, 4],
  [0, 13],
  [1, 3],
  [2, 5],
  [3, 7],
  [4, 5],
  [4, 8],
  [5, 9],
  [6, 8],
  [6, 9],
  [7, 8],
  [7, 14],
  [8, 12],
  [9, 10],
  [9, 19],
  [10, 19],
  [11, 12],
  [11, 17],
  [12, 15],
  [13, 14],
  [14, 16],
  [15, 16],
  [15, 17],
  [16, 18],
  [17, 18],
  [18, 19],
  [3, 8],
  [10, 11],
  [2, 5],
];

function MemoryGraph({ on }: { on: boolean }) {
  return (
    <svg
      className={`mems${on ? " on" : ""}`}
      viewBox="0 0 900 700"
      preserveAspectRatio="xMidYMid slice"
    >
      {EDGES.map(([a, b], i) => (
        <line
          key={i}
          className="mems-edge"
          pathLength={1}
          x1={MEMS[a].x}
          y1={MEMS[a].y}
          x2={MEMS[b].x}
          y2={MEMS[b].y}
          style={{ transitionDelay: `${(i % 10) * 70}ms` }}
        />
      ))}
      {/* the cast's eyes, peeking at the graph from the right-center */}
      <g className="mems-eyes" transform="translate(620 420)">
        <g transform="rotate(-8)">
          <path
            d="M0 30C0 8 16 -4 34 -4C52 -4 66 10 66 30C66 36 62 40 56 40C50 40 48 34 40 34C30 34 28 40 18 40C8 40 0 38 0 30Z"
            fill="#f5f2ea"
          />
          <path
            d="M12 36C12 22 20 12 32 12C43 12 50 22 50 34C50 38 46 41 40 41C30 41 24 36 12 36Z"
            fill="#1a1a1a"
            transform="translate(2 -2)"
          />
        </g>
        <g transform="translate(78 0) rotate(-8)">
          <path
            d="M0 30C0 8 16 -4 34 -4C52 -4 66 10 66 30C66 36 62 40 56 40C50 40 48 34 40 34C30 34 28 40 18 40C8 40 0 38 0 30Z"
            fill="#f5f2ea"
          />
          <path
            d="M12 36C12 22 20 12 32 12C43 12 50 22 50 34C50 38 46 41 40 41C30 41 24 36 12 36Z"
            fill="#1a1a1a"
            transform="translate(2 -2)"
          />
        </g>
      </g>
      {MEMS.map((m, i) =>
        m.label ? (
          <g
            key={i}
            className={`mems-pill${m.big ? " big" : ""}`}
            style={{ transitionDelay: `${300 + (i % 7) * 80}ms` }}
          >
            <circle className="mems-dot" cx={m.x} cy={m.y} r={5} />
            <rect
              x={m.x + 12}
              y={m.big ? -25 : -16}
              width={
                m.big ? m.label.length * 11 + 40 : m.label.length * 7.6 + 30
              }
              height={m.big ? 50 : 33}
              rx={17}
              transform={`translate(0 ${m.y})`}
            />
            <text x={m.x + 12 + (m.big ? 22 : 15)} y={m.y + (m.big ? 7 : 5)}>
              {m.label}
            </text>
          </g>
        ) : (
          <circle
            key={i}
            className="mems-node"
            cx={m.x}
            cy={m.y}
            r={4.5}
            style={{ transitionDelay: `${(i % 9) * 80}ms` }}
          />
        ),
      )}
    </svg>
  );
}

/* ── Chapter 3: the day/night orbit — sun riding a dashed ellipse ── */

function Orbit({ on }: { on: boolean }) {
  return (
    <svg
      className={`orbit${on ? " on" : ""}`}
      viewBox="0 0 900 700"
      preserveAspectRatio="xMidYMid slice"
    >
      <ellipse
        className="orbit-path"
        cx={470}
        cy={380}
        rx={430}
        ry={330}
        fill="none"
        strokeDasharray="3 9"
        transform="rotate(-14 470 380)"
      />
      {/* the sun rides the drawn orbit: the group carries the same -14°
          tilt as the ellipse, the badge itself has no transform (the
          motion path supplies the position — a translate here would
          double-offset it off the line), and SMIL keeps it off the JS
          budget. */}
      <g transform="rotate(-14 470 380)">
        <g>
          <circle r={16} fill="#fdfcf7" />
          <g stroke="#e8792e" strokeWidth={2} strokeLinecap="round">
            <circle cx={0} cy={0} r={4} fill="none" />
            {[...Array(8)].map((_, i) => {
              const a = (Math.PI * 2 * i) / 8;
              return (
                <line
                  key={i}
                  x1={Math.cos(a) * 7}
                  y1={Math.sin(a) * 7}
                  x2={Math.cos(a) * 10}
                  y2={Math.sin(a) * 10}
                />
              );
            })}
          </g>
          {/* the sleepy eyes circle the sun, staying upright as they go
              (rotate=0): the motion path lives in the sun's local frame,
              so the pair rides the same big-orbit animateMotion while
              spinning its own small one. */}
          <g
            className="orbit-eyes"
            transform="translate(-19.5 -3.75) scale(0.5)"
          >
            <path
              d="M0 14A17 17 0 0 1 34 14L34 18A17 9 0 0 1 0 18Z"
              fill="#fdfcf7"
            />
            <path
              d="M3 16A14 12 0 0 1 31 16L31 17A14 7 0 0 1 3 17Z"
              fill="#1a1a1a"
            />
            <path
              d="M44 14A17 17 0 0 1 78 14L78 18A17 9 0 0 1 44 18Z"
              fill="#fdfcf7"
            />
            <path
              d="M47 16A14 12 0 0 1 75 16L75 17A14 7 0 0 1 47 17Z"
              fill="#1a1a1a"
            />
            <animateMotion
              dur="14s"
              repeatCount="indefinite"
              rotate="0"
              path="M 40 0 A 40 40 0 1 1 39.9 -0.1 Z"
            />
          </g>
          <animateMotion
            dur="26s"
            repeatCount="indefinite"
            rotate="0"
            path="M 470 50 A 430 330 0 1 1 469.9 49.6 Z"
          />
        </g>
      </g>
      {/* the moon, holding its ground inside the orbit */}
      <g transform="translate(238 522)">
        <circle r={26} fill="#20201c" />
        <path
          d="M6 -14A15 15 0 1 0 15 6A12 12 0 0 1 6 -14Z"
          fill="#f5f2ea"
          transform="translate(-6 -4)"
        />
      </g>
      {/* a notification the cadet handled overnight */}
      <g className="orbit-pill" transform="translate(96 400)">
        <rect width={310} height={58} rx={16} fill="#f5f2ea" opacity={0.5} />
        <rect x={38} y={-8} width={280} height={52} rx={14} fill="#fdfcf7" />
        <circle
          cx={66}
          cy={18}
          r={9}
          fill="none"
          stroke="#2e8b4a"
          strokeWidth={1.6}
        />
        <path
          d="M62 18l3 3 5-6"
          fill="none"
          stroke="#2e8b4a"
          strokeWidth={1.8}
          strokeLinecap="round"
        />
        <text x={84} y={23} className="orbit-pill-time">
          6:58 AM
        </text>
        <text x={158} y={23} className="orbit-pill-text">
          Flights price-watched
        </text>
      </g>
    </svg>
  );
}

/* ── Chapter 4: the vault — the cast hiding behind devices with locks ── */

function LockBadge({ x, y, open }: { x: number; y: number; open?: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r={17} fill={open ? "#c9c7bd" : "#20201c"} />
      {open ? (
        <g stroke="#f5f2ea" strokeWidth={2.2} fill="none" strokeLinecap="round">
          <path d="M-4.5 -1v-3.5a4.5 4.5 0 0 1 8.6-1.8" />
          <rect
            x={-5.5}
            y={-1}
            width={11}
            height={9}
            rx={2}
            fill="#f5f2ea"
            stroke="none"
          />
        </g>
      ) : (
        <g stroke="#f5f2ea" strokeWidth={2.2} fill="none" strokeLinecap="round">
          <path d="M-4.5 -1v-3a4.5 4.5 0 0 1 9 0v3" />
          <rect
            x={-5.5}
            y={-1}
            width={11}
            height={9}
            rx={2}
            fill="#f5f2ea"
            stroke="none"
          />
        </g>
      )}
    </g>
  );
}

function Vault({ on }: { on: boolean }) {
  return (
    <svg
      className={`vault${on ? " on" : ""}`}
      viewBox="0 0 900 700"
      preserveAspectRatio="xMidYMid slice"
    >
      {/* the cloud */}
      <g className="vault-item" style={{ transitionDelay: "80ms" }}>
        <path
          d="M560 130a42 42 0 0 1 40-56 50 50 0 0 1 92-14 40 40 0 0 1 54 36 34 34 0 0 1-8 34H580a30 30 0 0 1-20-0Z"
          fill="#f5f2ea"
        />
        <LockBadge x={808} y={150} open />
      </g>
      {/* the yellow cast member hiding behind its own bottom edge */}
      <g className="vault-item" style={{ transitionDelay: "0ms" }}>
        <rect x={280} y={128} width={208} height={182} rx={26} fill="#f2c744" />
        <LockBadge x={488} y={122} />
      </g>
      {/* the laptop */}
      <g className="vault-item" style={{ transitionDelay: "180ms" }}>
        <rect x={300} y={330} width={310} height={200} rx={12} fill="#f5f2ea" />
        <circle cx={322} cy={352} r={4} fill="#c9c7bd" />
        <circle cx={338} cy={352} r={4} fill="#c9c7bd" />
        <circle cx={354} cy={352} r={4} fill="#c9c7bd" />
        <rect x={272} y={530} width={368} height={16} rx={8} fill="#efece2" />
        <LockBadge x={610} y={330} open />
      </g>
      {/* the phone */}
      <g className="vault-item" style={{ transitionDelay: "280ms" }}>
        <rect x={700} y={330} width={118} height={230} rx={26} fill="#f5f2ea" />
        <rect x={738} y={346} width={42} height={7} rx={3.5} fill="#c9c7bd" />
        <LockBadge x={818} y={330} open />
      </g>
      {/* one pair of eyes, teleporting from device to device (cloud →
          vault → laptop → phone) — positions live in the CSS keyframes,
          steps(1,end) makes each hop a cut instead of a slide. */}
      <g className="vault-eyes">
        <ellipse
          cx={-10}
          cy={0}
          rx={7}
          ry={10.5}
          fill="#fdfcf7"
          stroke="#1a1a1a"
          strokeWidth={1}
        />
        <ellipse cx={-9.4} cy={2} rx={3.5} ry={5.4} fill="#1a1a1a" />
        <ellipse
          cx={10}
          cy={0}
          rx={7}
          ry={10.5}
          fill="#fdfcf7"
          stroke="#1a1a1a"
          strokeWidth={1}
        />
        <ellipse cx={10.6} cy={2} rx={3.5} ry={5.4} fill="#1a1a1a" />
      </g>
    </svg>
  );
}

/* ── the pinned section ── */

/**
 * The gated mount: the whole section stays out of the page (and the HTML)
 * until the visitor knows the knock — seven consecutive clicks on the
 * hero title flip the session flag this listens for.
 */
export default function LandingChapters() {
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    const sync = () => setUnlocked(previewUnlocked());
    sync();
    window.addEventListener(PREVIEW_EVENT, sync);
    return () => window.removeEventListener(PREVIEW_EVENT, sync);
  }, []);

  if (!unlocked) {
    return null;
  }
  return <ChaptersSection />;
}

function ChaptersSection() {
  const ref = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    let raf = 0;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const span = el.offsetHeight - window.innerHeight;
      const progress = Math.min(1, Math.max(0, -rect.top / Math.max(1, span)));
      setActive(
        Math.min(CHAPTERS.length - 1, Math.floor(progress * CHAPTERS.length)),
      );
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  // Jump into a chapter: the scroll listener derives the active one from
  // how far the 400vh section has been scrolled, so clicking a title just
  // scrolls to a point a hair inside that chapter's quarter of the span.
  const jumpToChapter = (i: number) => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const top = el.getBoundingClientRect().top + window.scrollY;
    const span = el.offsetHeight - window.innerHeight;
    window.scrollTo({
      top: top + span * ((i + 0.02) / CHAPTERS.length),
      behavior: "smooth",
    });
  };

  return (
    <section
      ref={ref}
      className="chapters"
      style={{ background: CHAPTERS[active].color }}
    >
      <div className="chapters-pin">
        <div className="chapters-copy">
          {CHAPTERS.map((c, i) => (
            <div
              key={c.title}
              className={i === active ? "chapter on" : "chapter"}
            >
              <h3>
                <button
                  type="button"
                  className="chapter-jump"
                  onClick={() => jumpToChapter(i)}
                >
                  {c.title}
                </button>
              </h3>
              {i === active && <p>{c.copy}</p>}
            </div>
          ))}
        </div>
        <div className="chapters-stage">
          <PersonalityDials on={active === 0} />
          <MemoryGraph on={active === 1} />
          <Orbit on={active === 2} />
          <Vault on={active === 3} />
        </div>
      </div>
    </section>
  );
}
