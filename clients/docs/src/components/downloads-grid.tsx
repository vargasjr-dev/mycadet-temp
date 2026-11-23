"use client";

import { useState, useSyncExternalStore, type MouseEvent } from "react";
import Image from "next/image";
import {
  downloadsCardOrder,
  type DownloadsCardId,
} from "@/lib/detect-platform";
import CopyButton from "./copy-button";
import { APEX_DOMAIN, APEX_ORIGIN } from "@/lib/domains";

const INSTALL_COMMAND = `curl -fsSL ${APEX_ORIGIN}/install.sh | bash`;

const CARD_TITLES: Record<DownloadsCardId, string> = {
  iphone: "Cadet for iPhone",
  android: "Cadet for Android",
  mac: "Cadet for Mac",
  linux: "Cadet for Linux",
  chrome: "Cadet for Chrome",
  windows: "Cadet for Windows",
  terminal: "Cadet for Terminal",
};

const CARD_TAGLINES: Record<DownloadsCardId, string> = {
  iphone: "Your assistant in your pocket.",
  android: "Your assistant in your pocket.",
  mac: "Your assistant on your desk.",
  linux: "Your assistant on your Linux desktop.",
  chrome: "Your assistant in your browser.",
  windows: "Your assistant on your PC.",
  terminal: "Your assistant, on your own hardware.",
};

const COMING_SOON: Record<
  Exclude<DownloadsCardId, "mac" | "terminal" | "windows" | "linux">,
  string
> = {
  iphone: "📱 Coming soon!",
  android: "🤖 Coming soon!",
  chrome: "🌐 Coming soon!",
};

const COMING_SOON_NOTES: Record<
  Exclude<DownloadsCardId, "mac" | "terminal" | "windows" | "linux">,
  string
> = {
  iphone: "Your pocket cadet is still in training — check back soon.",
  android: "This pocket cadet is still in training too — check back soon.",
  chrome: "Your browser cadet is still drilling — check back soon.",
};

// Resolve the newest versioned release that actually contains the installer.
const desktopDownloadUrls = (platform: string) => ({
  dev: `/downloads/desktop/${platform}?channel=dev`,
  prod: `/downloads/desktop/${platform}?channel=prod`,
});
const DESKTOP_DOWNLOAD_URLS = {
  mac: desktopDownloadUrls("mac"),
  windows: desktopDownloadUrls("windows"),
  linux: desktopDownloadUrls("linux"),
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
  typeof window === "undefined" || window.location.hostname === APEX_DOMAIN
    ? "prod"
    : "dev";

function Glyph({ id }: { id: DownloadsCardId }) {
  switch (id) {
    case "mac":
    case "linux":
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

function DesktopDownloadLink({ href, label }: { href: string; label: string }) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  async function download(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    if (state === "loading") return;

    setState("loading");
    try {
      const response = await fetch(href, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.type === "opaqueredirect") {
        // Older cloud deployments still answer with a direct redirect.
        window.location.assign(href);
      } else {
        if (!response.ok) throw new Error("Installer unavailable");
        const { url } = await response.json();
        if (typeof url !== "string" || !url.startsWith("https://github.com/")) {
          throw new Error("Invalid installer URL");
        }
        window.location.assign(url);
      }
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <>
      <a
        className="btn dl-cta"
        href={href}
        onClick={download}
        aria-disabled={state === "loading" || undefined}
        aria-busy={state === "loading" || undefined}
      >
        {state === "loading" ? "Preparing download…" : label}
      </a>
      <span className="dl-download-status" role="status">
        {state === "error" ? "Couldn’t start the download. Try again." : ""}
      </span>
    </>
  );
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
          {id === "terminal" || id === "windows" || id === "linux" ? (
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
      ) : id === "mac" || id === "windows" || id === "linux" ? (
        <>
          <p className="dl-note">
            {environment === "dev"
              ? "The dev channel's latest build, straight from the release train."
              : "The latest release, straight from the release train."}
          </p>
          <DesktopDownloadLink
            href={DESKTOP_DOWNLOAD_URLS[id][environment]}
            label={`Download for ${id === "mac" ? "Mac" : id === "linux" ? "Linux" : "Windows"}`}
          />
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

// Keep server rendering and hydration in canonical order before reading the UA.
const subscribe = () => () => {};

export default function DownloadsGrid() {
  const isClient = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const order = downloadsCardOrder(isClient ? navigator.userAgent : null);
  const environment = isClient ? downloadsEnvironment() : "prod";

  return (
    <div className="dl-grid">
      {order.map((id) => (
        <Card key={id} id={id} environment={environment} />
      ))}
    </div>
  );
}
