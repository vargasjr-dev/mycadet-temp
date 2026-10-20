"use client";

import { CloudOff } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useAssistantRequest } from "./assistant/use-assistant-request";
import { AppI18nProvider } from "./i18n/provider";
import { useTranslation } from "./i18n/react";
import { AssistantFrame } from "./shell/assistant-frame";
import { routes } from "./utils/routes";

export interface AppShellProps {
  apiBaseUrl?: string;
  assistantId?: string;
  location: string;
  origin: string;
  mountPath?: string;
  onNavigate(path: string, options: { replace: boolean }): void;
  title?: string;
}

/** Portable React entry. Resolves assistants through the host API; the host owns browser navigation. */
export function AppShell(props: AppShellProps) {
  return (
    <AppI18nProvider>
      <AssistantShell key={props.assistantId} {...props} />
    </AppI18nProvider>
  );
}

// Inline styles so the portable bundle and the standalone build render the
// failure states identically (the panel has no stylesheet contract of its
// own). The vars are the design-library tokens the standalone bundle ships;
// the literals are the dark-theme values they resolve to.
const primaryButton: CSSProperties = {
  borderRadius: 8,
  border: "none",
  padding: "10px 20px",
  fontSize: 14,
  fontWeight: 600,
  background: "var(--primary-base, #FDFDFC)",
  color: "var(--content-inset, #17191C)",
  cursor: "pointer",
};

const quietButton: CSSProperties = {
  borderRadius: 8,
  border: "1px solid var(--content-tertiary, #8D99A5)",
  padding: "8px 16px",
  fontSize: 13,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
};

/** The wake failure's display line: the cloud route puts cadet-host's own
 * punchline in `reason` (502) and the v1 refusals in `detail` (4xx). */
function wakeFailureMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  if ("reason" in body && typeof body.reason === "string") return body.reason;
  if ("detail" in body && typeof body.detail === "string") return body.detail;
  return null;
}

function AssistantShell({
  apiBaseUrl = "/",
  assistantId,
  location,
  origin,
  mountPath = "/assistant",
  onNavigate,
  title,
}: AppShellProps) {
  const { t } = useTranslation("account");
  // The wake flow — the user-facing recovery for the not-ready state: the
  // same drive the admin console's Wake button gets (wake the vm; a
  // missing vm hatches in place), through the same-origin /v1 proxy with
  // the session cookie. On success the detail is re-fetched and the frame
  // mounts; on failure the node's own punchline shows under the button.
  const [wakePending, setWakePending] = useState(false);
  const [wakeReason, setWakeReason] = useState<string | null>(null);
  const { state, retry: reload } = useAssistantRequest({
    apiBaseUrl,
    origin,
    assistantId,
  });
  // Picking is the account chooser's job — an assistant-agnostic account
  // flow at a constant path on every surface. Without an id to act on (the
  // list resolved with nothing chosen, no assistants at all, or no
  // session), the shell replace-navigates to it and shows the state line
  // until the router swaps; the chooser hands the pick back as location
  // state, which AssistantPage feeds in as the assistantId prop.
  const chooserOwned =
    state.status === "selection" ||
    state.status === "empty" ||
    state.status === "unauthenticated";
  const redirected = useRef(false);
  useEffect(() => {
    if (chooserOwned && !redirected.current) {
      redirected.current = true;
      onNavigate(routes.account.selectAssistant, { replace: true });
    }
  }, [chooserOwned, onNavigate]);

  async function wake() {
    if (!assistantId || wakePending) return;
    setWakePending(true);
    setWakeReason(null);
    try {
      const base = new URL(apiBaseUrl, origin);
      base.pathname = base.pathname.replace(/\/*$/, "/");
      const response = await fetch(
        new URL(`v1/assistants/${encodeURIComponent(assistantId)}/wake/`, base),
        { method: "POST", credentials: "include" },
      );
      if (response.ok) {
        setWakePending(false);
        reload();
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      setWakeReason(wakeFailureMessage(body) ?? t("appShell.wakeFailed"));
    } catch {
      setWakeReason(t("appShell.wakeFailed"));
    }
    setWakePending(false);
  }

  if (state.status !== "ready") {
    const alert = state.status === "notReady" || state.status === "error";
    return (
      <div
        role={alert ? "alert" : "status"}
        style={{
          minHeight: "100svh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: 24,
          textAlign: "center",
        }}
      >
        {state.status === "notReady" ? (
          <NotReadyBody
            wakePending={wakePending}
            wakeReason={wakeReason}
            onWake={wake}
          />
        ) : state.status === "error" ? (
          <ErrorBody />
        ) : (
          <p style={{ margin: 0 }}>{t(`appShell.${state.status}`)}</p>
        )}
        {(state.status === "error" || state.status === "unavailable") && (
          <button type="button" onClick={reload} style={quietButton}>
            {t("appShell.retry")}
          </button>
        )}
      </div>
    );
  }
  const assistant = state.assistant;
  return (
    <AssistantFrame
      key={`${assistant.id}:${assistant.version}:${assistant.url}:${mountPath}:${origin}`}
      assistant={assistant}
      location={location}
      origin={origin}
      mountPath={mountPath}
      onNavigate={onNavigate}
      title={title ?? t("appShell.title")}
    />
  );
}

/** The 409 "assistant is not ready" resolution — deliberately NOT the
 * starting sentiment: the API only reports that the assistant isn't ready
 * (never hatched, stopped, or mid-release-resolution). The action is the
 * wake: the same recovery drive the admin console's Wake button gets, so
 * both the admin and the user hold a path back into the assistant (the
 * retry stays for the states where nothing can be woken). Modeled on the
 * web app's full-page failure treatment (icon + title + body + a primary
 * action, centered); inline styles so the portable bundle and the
 * standalone build render it identically.
 */
function NotReadyBody({
  wakePending,
  wakeReason,
  onWake,
}: {
  wakePending: boolean;
  wakeReason: string | null;
  onWake(): void;
}) {
  const { t } = useTranslation("account");
  return (
    <>
      <CloudOff size={28} aria-hidden="true" />
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>
        {t("appShell.notReadyTitle")}
      </h1>
      <p style={{ margin: 0, maxWidth: 420, opacity: 0.7, lineHeight: 1.5 }}>
        {t("appShell.notReadyBody")}
      </p>
      {wakeReason !== null && (
        <p
          style={{
            margin: 0,
            maxWidth: 420,
            fontSize: 13,
            opacity: 0.6,
            lineHeight: 1.5,
          }}
        >
          {wakeReason}
        </p>
      )}
      <button
        type="button"
        onClick={onWake}
        disabled={wakePending}
        style={{ ...primaryButton, opacity: wakePending ? 0.6 : 1 }}
      >
        {wakePending ? t("appShell.waking") : t("appShell.wake")}
      </button>
    </>
  );
}

/** The generic resolution failure — the request itself did not go through
 * (network trouble, an unreachable API, a 5xx). Deliberately NOT the
 * starting sentiment: nothing about the assistant's lifecycle is known,
 * so retry (not wake) is the action. Modeled on the web app's full-page
 * failure treatment; inline styles so the portable bundle and the
 * standalone build render it identically.
 */
function ErrorBody() {
  const { t } = useTranslation("account");
  return (
    <>
      <CloudOff size={28} aria-hidden="true" />
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>
        {t("appShell.errorTitle")}
      </h1>
      <p style={{ margin: 0, maxWidth: 420, opacity: 0.7, lineHeight: 1.5 }}>
        {t("appShell.errorBody")}
      </p>
    </>
  );
}
