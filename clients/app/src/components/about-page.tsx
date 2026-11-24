import { useEffect, useState } from "react";

import type { AppVersionInfo } from "@mycadet/ipc-contract";
import { cn } from "@mycadet/design-library/utils/cn";
import { textLinkVariants } from "@mycadet/design-library/components/text-link";

import { isElectron } from "@app/runtime/is-electron";
import { detectClientOs } from "@app/runtime/client-os";
import { useTranslation } from "@app/i18n";

/**
 * Branded About page rendered inside the Electron About BrowserWindow.
 * The window is sandboxed, non-resizable, and chromeless except for macOS
 * traffic-light buttons; the layout assumes that frame and centers content
 * vertically.
 *
 * Version + commit SHA + copyright come from the Electron host via the
 * `window.cadet.app.versionInfo()` bridge. The host wrapper returns
 * `null`-shaped data off-Electron and the page renders a generic web
 * fallback rather than crashing.
 */
export function AboutPage() {
  const { t } = useTranslation();
  const isWindows = detectClientOs() === "windows";
  const [info, setInfo] = useState<AppVersionInfo | null>(null);

  useEffect(() => {
    if (isElectron()) {
      void window.cadet?.app
        .versionInfo()
        .then(setInfo)
        .catch(() => {});
    }
  }, []);

  const display = info ?? FALLBACK;

  return (
    <div className="flex h-svh w-screen flex-col items-center justify-center bg-background px-8 pt-14 pb-8 text-center text-foreground select-none">
      <h1 className="mt-4 text-2xl font-semibold">{display.appName}</h1>
      <p className="text-muted-foreground mt-1 mb-7 text-xs">
        {isWindows
          ? t("aboutPage.taglineWindows")
          : t("aboutPage.taglineMacOS")}
      </p>
      <dl className="mb-7 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground text-right">
          {t("aboutPage.version")}
        </dt>
        <dd className="text-left font-mono tabular-nums select-text">
          {display.version}
        </dd>
        <dt className="text-muted-foreground text-right">
          {t("aboutPage.build")}
        </dt>
        <dd className="text-left font-mono tabular-nums select-text">
          {display.commitSha}
        </dd>
        {display.cliPath && (
          <>
            <dt className="text-muted-foreground text-right">
              {t("aboutPage.cliPath")}
            </dt>
            <dd className="min-w-0 text-left font-mono text-xs break-all select-text">
              {display.cliPath}
            </dd>
          </>
        )}
      </dl>
      <a
        href={display.website}
        className={cn(textLinkVariants(), "text-sm")}
        onClick={(event) => {
          // Off Electron, let the browser navigate via the `href`. In
          // Electron the renderer is sandboxed, so the only outbound
          // path is the IPC route through `shell.openExternal` in main;
          // suppressing the default there keeps the About BrowserWindow
          // from navigating away from its own route.
          if (!isElectron()) {
            return;
          }
          event.preventDefault();
          void window.cadet?.app.openWebsite();
        }}
      >
        {new URL(display.website).host}
      </a>
      <div className="text-muted-foreground mt-auto pt-6 text-[11px]">
        {display.copyright}
      </div>
    </div>
  );
}

const FALLBACK: AppVersionInfo = {
  appName: "Cadet",
  version: "—",
  commitSha: "—",
  copyright: `© ${new Date().getFullYear()} Cadet`,
  website: "https://mycadet.ai",
};
