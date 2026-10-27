import { CloudOff } from "lucide-react";
import { useEffect } from "react";

import { Typography } from "@mycadet/design-library";
import { Button } from "@mycadet/design-library/components/button";

import { useTranslation } from "@/i18n";
import { markNativeLaunchScreenReady } from "@/runtime/native-launch-screen";

export const STARTUP_FAILURE_TITLE = "Cadet couldn't start";
export const STARTUP_FAILURE_MESSAGE =
  "Reload the app to try again. If this keeps happening, update or reinstall the app.";

/**
 * The boot-failure floor, shared by the `ErrorBoundary` fallback and
 * `boot`'s pre-render catch. Visual language matches the assistant
 * resolution error (`ActiveAssistantError`): icon, honest copy, retry —
 * the same failure, one step earlier in the boot.
 *
 * `error` is the thrown value that sank the boot, when one exists: its
 * message renders under the generic copy so the screen carries signal for
 * support instead of a dead end.
 */
export function StartupFailure({ error }: { error?: unknown }) {
  const { t } = useTranslation();
  const detail = error instanceof Error ? error.message : undefined;

  useEffect(() => {
    void markNativeLaunchScreenReady("system");
  }, []);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--background)] p-6 text-[var(--content-tertiary)]">
      <div
        role="alert"
        className="flex max-w-md flex-col items-center gap-[var(--app-spacing-md)] text-center"
      >
        <CloudOff className="size-6" aria-hidden="true" />
        <Typography variant="body-medium-default">
          {STARTUP_FAILURE_TITLE}
        </Typography>
        <p className="text-body-medium-lighter text-[var(--content-secondary)]">
          {STARTUP_FAILURE_MESSAGE}
        </p>
        {detail ? (
          <p className="max-w-md font-mono text-xs break-words text-[var(--content-tertiary)]">
            {detail}
          </p>
        ) : null}
        <Button variant="ghost" onClick={() => window.location.reload()}>
          {t("startupFailure.reloadApp")}
        </Button>
      </div>
    </main>
  );
}
