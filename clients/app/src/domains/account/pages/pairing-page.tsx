import { AlertCircle, CheckCircle2, LoaderCircle, Smartphone } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { Button } from "@mycadet/design-library/components/button";

import {
  activateRemoteGatewaySession,
  exchangeRemoteWebPairingToken,
  RemoteWebPairingError,
} from "@app/lib/auth/remote-gateway-session";
import { sanitizeReturnTo } from "@app/utils/return-to";
import { routes } from "@app/utils/routes";
import { useTranslation } from "@app/i18n";
import { parseRemoteWebPairingParams } from "@mycadet/service-contracts/remote-web-pairing";

type PairingDetails = {
  deviceCode: string;
  userCode: string | null;
};

type PairingState =
  | { kind: "awaiting_code" }
  | { kind: "verifying" }
  | { kind: "polling"; expiresAt: string | null }
  | { kind: "approved" }
  | { kind: "expired" }
  | { kind: "error"; message: string };

function statusCopy(state: PairingState): { title: string; body: string } {
  switch (state.kind) {
    case "awaiting_code":
      return {
        title: "Pair a device",
        body: 'On the machine running your assistant, run "cadet pair", then enter the code it prints below the QR code here.',
      };
    case "verifying":
      return {
        title: "Pairing",
        body: "Connecting this device to your assistant.",
      };
    case "approved":
      return {
        title: "Connected",
        body: "Opening your assistant.",
      };
    case "expired":
      return {
        title: "Pairing expired",
        body: "This pairing code is invalid or expired. Run cadet pair on the machine running your assistant to get a new one.",
      };
    case "error":
      return {
        title: "Pairing failed",
        body: state.message,
      };
    case "polling":
      return {
        title: "Waiting for approval",
        body: "Confirm this code on the machine running your assistant.",
      };
  }
}

function StatusIcon({ state }: { state: PairingState }) {
  if (state.kind === "approved") {
    return (
      <CheckCircle2
        className="h-5 w-5 text-[var(--system-positive-strong)]"
        aria-hidden
      />
    );
  }
  // Not a loader: this state waits on the user to enter the code the host
  // printed, so a spinner — live or frozen — reads as a broken loading
  // state. The page pairs a device; the glyph says which one.
  if (state.kind === "awaiting_code") {
    return (
      <Smartphone
        className="h-5 w-5 text-[var(--system-info-strong)]"
        aria-hidden
      />
    );
  }
  if (state.kind === "verifying" || state.kind === "polling") {
    return (
      <LoaderCircle
        className="h-5 w-5 animate-spin text-[var(--system-info-strong)]"
        aria-hidden
      />
    );
  }
  return (
    <AlertCircle
      className="h-5 w-5 text-[var(--system-negative-strong)]"
      aria-hidden
    />
  );
}

/**
 * Strip the burned `#device_code=` fragment (and any query variants) from the
 * address bar after a successful exchange, preserving `returnTo`, so the spent
 * code does not linger in the location bar or get re-submitted on reload.
 */
function clearDeviceCodeFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    for (const key of ["deviceCode", "device_code", "userCode", "user_code"]) {
      url.searchParams.delete(key);
    }
    url.hash = "";
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  } catch {
    // history.replaceState unavailable — the burned code is inert regardless.
  }
}

export function PairingPage() {
  const { t } = useTranslation("account");
  const location = useLocation();
  const navigate = useNavigate();
  const returnTo = useMemo(() => {
    const value = new URLSearchParams(location.search).get("returnTo");
    return sanitizeReturnTo(value, routes.assistant);
  }, [location.search]);
  const params = useMemo(
    () =>
      parseRemoteWebPairingParams(
        `${location.pathname}${location.search}${location.hash}`,
      ),
    [location.pathname, location.search, location.hash],
  );

  const [pairing, setPairing] = useState<PairingDetails | null>(() =>
    params.deviceCode
      ? {
          deviceCode: params.deviceCode,
          userCode: params.userCode,
        }
      : null,
  );

  const [state, setState] = useState<PairingState>(() =>
    params.deviceCode ? { kind: "verifying" } : { kind: "awaiting_code" },
  );

  const [codeDraft, setCodeDraft] = useState("");

  const handleCodeSubmit = useCallback(() => {
    const deviceCode = codeDraft.trim();
    if (!deviceCode) {
      return;
    }
    setPairing({ deviceCode, userCode: null });
    setState({ kind: "verifying" });
  }, [codeDraft]);

  useEffect(() => {
    if (!pairing?.deviceCode) {
      return;
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const result = await exchangeRemoteWebPairingToken(
          pairing.deviceCode,
          controller.signal,
        );
        if (result.status === "pending") {
          setState({ kind: "polling", expiresAt: result.expiresAt || null });
          timeout = setTimeout(
            () => void poll(),
            Math.max(1, result.intervalSeconds) * 1000,
          );
          return;
        }

        activateRemoteGatewaySession(result);
        // Drop the burned device code from the URL before navigating so it
        // never lingers in the address bar or re-submits on reload.
        clearDeviceCodeFromUrl();
        setState({ kind: "approved" });
        timeout = setTimeout(() => navigate(returnTo, { replace: true }), 250);
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        if (err instanceof RemoteWebPairingError && err.status === 401) {
          setState({ kind: "expired" });
          return;
        }
        if (
          err instanceof RemoteWebPairingError &&
          err.code === "GUARDIAN_REPAIR_REQUIRED"
        ) {
          // A new pairing would hit the same failure; the approved code stays
          // exchangeable after guardian repair, so point at repair + retry.
          setState({
            kind: "error",
            message:
              "The assistant's trust database needs repair. Run guardian repair on the machine hosting the assistant, then retry this same pairing link — the code stays valid.",
          });
          return;
        }
        setState({
          kind: "error",
          message:
            "The assistant could not complete pairing. Try starting a new pairing.",
        });
      }
    };

    void poll();

    return () => {
      controller.abort();
      if (timeout) {
        clearTimeout(timeout);
      }
    };
  }, [pairing?.deviceCode, navigate, returnTo]);

  const handleCancel = useCallback(() => {
    // Single origin: the chooser is an app route on the origin the shell
    // already serves.
    navigate(routes.account.selectAssistant, { replace: true });
  }, []);

  const copy = statusCopy(state);

  return (
    <main className="flex min-h-svh items-center justify-center bg-[var(--surface-base)] px-6 py-10 text-[var(--content-default)]">
      <section className="w-full max-w-md rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] p-8 shadow-[var(--shadow-sm)]">
        <div className="mb-5 flex items-center gap-3">
          <StatusIcon state={state} />
          <h1 className="text-title-medium text-[var(--content-emphasised)]">
            {copy.title}
          </h1>
        </div>

        {state.kind === "polling" && pairing?.userCode ? (
          <div className="mb-5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-4 text-center">
            <div className="text-label-small-default uppercase tracking-wide text-[var(--content-tertiary)]">
              {t("pairingPage.pairingCode")}
            </div>
            <div className="mt-2 font-mono text-3xl font-semibold tracking-[0.18em] text-[var(--content-emphasised)]">
              {pairing.userCode}
            </div>
          </div>
        ) : null}

        <p className="text-body-medium-lighter leading-6 text-[var(--content-secondary)]">
          {copy.body}
        </p>

        {state.kind === "awaiting_code" ? (
          <form
            className="mt-6 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              handleCodeSubmit();
            }}
          >
            <input
              type="text"
              value={codeDraft}
              onChange={(event) => setCodeDraft(event.target.value)}
              placeholder={t("pairingPage.pairingCode")}
              aria-label={t("pairingPage.pairingCode")}
              className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2 font-mono text-body-medium-default tracking-wide text-[var(--content-default)]"
            />
            <Button type="submit" variant="primary" fullWidth>
              {t("pairingPage.pair")}
            </Button>
          </form>
        ) : null}

        {state.kind === "polling" && state.expiresAt ? (
          <p className="text-body-small-lighter mt-4 text-[var(--content-tertiary)]">
            {t("pairingPage.expiresAt", {
              time: new Date(state.expiresAt).toLocaleTimeString(),
            })}
          </p>
        ) : null}

        {state.kind === "polling" ? (
          <Button
            variant="outlined"
            fullWidth
            className="mt-6"
            onClick={handleCancel}
          >
            {t("pairingPage.cancel")}
          </Button>
        ) : null}

        {state.kind === "expired" ? (
          <Button
            variant="outlined"
            fullWidth
            className="mt-6"
            onClick={() => {
              setPairing(null);
              setCodeDraft("");
              setState({ kind: "awaiting_code" });
            }}
          >
            {t("pairingPage.enterNewCode")}
          </Button>
        ) : null}
      </section>
    </main>
  );
}
