"use client";

import { useLayoutEffect, useState } from "react";
import Image from "next/image";
import {
  downloadsCardOrder,
  type DownloadsCardId,
} from "@/lib/detect-platform";
import CopyButton from "./copy-button";

const INSTALL_COMMAND = "curl -fsSL https://mycadet.ai/install.sh | bash";

const CARD_TITLES: Record<DownloadsCardId, string> = {
  iphone: "Cadet for iPhone",
  android: "Cadet for Android",
  mac: "Cadet for Mac",
  chrome: "Cadet for Chrome",
  windows: "Cadet for Windows",
  terminal: "Cadet for Terminal",
};

const CARD_TAGLINES: Record<DownloadsCardId, string> = {
  iphone: "Your assistant in your pocket.",
  android: "Your assistant in your pocket.",
  mac: "Your assistant on your desk.",
  chrome: "Your assistant in your browser.",
  windows: "Your assistant on your PC.",
  terminal: "Your assistant, on your own hardware.",
};

const COMING_SOON: Record<
  Exclude<DownloadsCardId, "mac" | "terminal" | "windows">,
  string
> = {
  iphone: "📱 Coming soon!",
  android: "🤖 Coming soon!",
  chrome: "🌐 Coming soon!",
};

const COMING_SOON_NOTES: Record<
  Exclude<DownloadsCardId, "mac" | "terminal" | "windows">,
  string
> = {
  iphone: "Your pocket cadet is still in training — check back soon.",
  android: "This pocket cadet is still in training too — check back soon.",
  chrome: "Your browser cadet is still drilling — check back soon.",
};

// The desktop builds live in the updates bucket the release handler
// publishes to — this deployment's own channel serves the link (the prod
// marketing site hands out the prod build, the dev deployment the dev one).
// Mac's installer keeps a version-free name; windows' NSIS installer name
// carries the version, so its card links the channel's feed root, where
// latest.yml and the current installer live.
const DESKTOP_DOWNLOAD_URLS: Record<
  "mac" | "windows",
  Record<"dev" | "prod", string>
> = {
  mac: {
    dev: "https://storage.googleapis.com/mycadet-dev-releases/mac-electron/arm64/mycadet-electron-dev.dmg",
    prod: "https://storage.googleapis.com/mycadet-prod-releases/mac-electron/arm64/mycadet-electron.dmg",
  },
  windows: {
    dev: "https://storage.googleapis.com/mycadet-dev-releases/win-electron/x64/",
    prod: "https://storage.googleapis.com/mycadet-prod-releases/win-electron/x64/",
  },
};

function comingSoonFor(
  id: DownloadsCardId,
): { note: string; label: string } | null {
  switch (id) {
    case "iphone":
      return { note: COMING_SOON_NOTES.iphone, label: COMING_SOON.iphone };
    case "android":
      return { note: COMING_SOON_NOTES.android, label: COMING_SOON.android };
    case "chrome":
      return { note: COMING_SOON_NOTES.chrome, label: COMING_SOON.chrome };
    default:
      return null;
  }
}

const downloadsEnvironment = (): "dev" | "prod" =>
  typeof window === "undefined" || window.location.hostname === "mycadet.ai"
    ? "prod"
    : "dev";

function Glyph({ id }: { id: DownloadsCardId }) {
  switch (id) {
    case "mac":
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 64 64"
          fill="none"
          aria-hidden="true"
        >
          <rect
            x="15"
            y="15"
            width="34"
            height="23"
            rx="3"
            stroke="var(--ink)"
            strokeWidth="3"
          />
          <path
            d="M9 44h46"
            stroke="var(--ink)"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      );
    case "windows":
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 64 64"
          fill="none"
          aria-hidden="true"
        >
          <rect x="16" y="16" width="15" height="15" fill="var(--ink)" />
          <rect x="33" y="16" width="15" height="15" fill="var(--ink)" />
          <rect x="16" y="33" width="15" height="15" fill="var(--ink)" />
          <rect x="33" y="33" width="15" height="15" fill="var(--ink)" />
        </svg>
      );
    case "chrome":
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 64 64"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="32" cy="32" r="17" stroke="var(--ink)" strokeWidth="3" />
          <ellipse
            cx="32"
            cy="32"
            rx="7.5"
            ry="17"
            stroke="var(--ink)"
            strokeWidth="3"
          />
          <path d="M15 32h34" stroke="var(--ink)" strokeWidth="3" />
        </svg>
      );
    case "terminal":
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 64 64"
          fill="none"
          aria-hidden="true"
        >
          <rect x="10" y="14" width="44" height="36" rx="6" fill="var(--ink)" />
          <path
            d="M20 27l8 6.5-8 6.5"
            stroke="#faf9f6"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M32 40h12" stroke="#faf9f6" strokeWidth="3" />
        </svg>
      );
    default:
      return null;
  }
}

function Card({
  id,
  environment,
}: {
  id: DownloadsCardId;
  environment: "dev" | "prod";
}) {
  return (
    <div className="dl-card">
      <h2>{CARD_TITLES[id]}</h2>
      <p className="dl-tagline">{CARD_TAGLINES[id]}</p>

      {id === "iphone" || id === "android" ? (
        <div className="dl-visual">
          <div className="dl-qr dl-qr-soon">
            <Image
              src={
                id === "iphone" ? "/docs/qr-iphone.png" : "/docs/qr-android.png"
              }
              alt={
                id === "iphone"
                  ? "QR code that opens Cadet on an iPhone"
                  : "QR code that opens Cadet on an Android phone"
              }
              width={128}
              height={128}
            />
          </div>
        </div>
      ) : (
        <div className="dl-visual">
          {id === "terminal" || id === "windows" ? (
            <Glyph id={id} />
          ) : (
            <div className="dl-visual-soon">
              <Glyph id={id} />
            </div>
          )}
        </div>
      )}

      {id === "terminal" ? (
        <>
          <div className="dl-code-row">
            <code className="dl-code">{INSTALL_COMMAND}</code>
            <CopyButton text={INSTALL_COMMAND} />
          </div>
          <a className="dl-link" href="/docs/hosting-options/local-hosting">
            Read the local hosting guide
          </a>
        </>
      ) : id === "mac" || id === "windows" ? (
        <>
          <p className="dl-note">
            {environment === "dev"
              ? "The dev channel's latest build, straight from the release train."
              : "The latest release, straight from the release train."}
          </p>
          <a
            className="btn dl-cta"
            href={DESKTOP_DOWNLOAD_URLS[id][environment]}
          >
            Download for {id === "mac" ? "Mac" : "Windows"}
          </a>
        </>
      ) : comingSoonFor(id) ? (
        <>
          <p className="dl-note">{comingSoonFor(id)!.note}</p>
          <button type="button" className="btn dl-cta dl-cta-soon" disabled>
            {comingSoonFor(id)!.label}
          </button>
        </>
      ) : null}
    </div>
  );
}

/** The downloads page's card grid, as a client component so the page
 * itself can render STATIC. The one per-visitor behavior moved in here
 * from the old per-request server render: the user-agent card ordering
 * (canonical order on the server + first paint — downloadsCardOrder(null)
 * is the canonical order, so SSR/hydration match — reordered via
 * useLayoutEffect before paint once the real UA is known). */
export default function DownloadsGrid() {
  const [order, setOrder] = useState<DownloadsCardId[]>(() =>
    downloadsCardOrder(null),
  );
  // SSR renders the prod link (the canonical page), a dev deployment's
  // client repaints onto its own channel before paint — the same
  // before-paint swap the UA ordering uses.
  const [environment, setEnvironment] = useState<"dev" | "prod">("prod");

  useLayoutEffect(() => {
    setOrder(downloadsCardOrder(navigator.userAgent));
    setEnvironment(downloadsEnvironment());
  }, []);

  return (
    <div className="dl-grid">
      {order.map((id) => (
        <Card key={id} id={id} environment={environment} />
      ))}
    </div>
  );
}
