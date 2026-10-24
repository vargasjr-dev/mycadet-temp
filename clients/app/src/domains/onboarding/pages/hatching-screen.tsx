import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { hatchAssistant } from "@app/assistant/api";
import { seedHatchAvatar } from "@app/assistant/avatar-traits";
import {
  hatchLocalAssistantHost,
  readLockfileHost,
  statusLocalAssistantHost,
} from "@app/assistant/local-mode-host";
import { writeSelectedAssistantId } from "@app/assistant/selected-assistant-storage";
import { AccountShell } from "@app/components/account/account-shell";
import { NEW_ASSISTANT_PARAM } from "@app/domains/onboarding/onboarding-destination";
import { SETUP_NAVIGATE } from "@app/domains/onboarding/onboarding-navigation";
import { ATTRIBUTED_PLUGIN_PARAM } from "@app/domains/onboarding/plugin-attribution";
import { useTranslation } from "@app/i18n";
import { isLocalClient } from "@app/lib/runtime-mode";
import { routes } from "@app/utils/routes";
import { Button } from "@mycadet/design-library/components/button";
import { ProgressBar } from "@mycadet/design-library/components/progress-bar";
import { captureError } from "@mycadet/design-library/utils/capture-error";
import type { CharacterTraits } from "@web/types/avatar";
import { BUNDLED_COMPONENTS } from "@web/utils/avatar-bundled-components";
import { randomCharacterTraits } from "@web/utils/avatar-random";
import { composeSvg } from "@web/utils/avatar-svg-compositor";

const COMPLETION_NAVIGATE_DELAY_MS = 800;

// Web's hatch-wait constants, inlined until the state core re-home gives them
// a shared package home. A local hatch waits out the CLI's background
// daemon+gateway startup before handing off.
const POLL_INTERVAL_MS = 3000;
const MAX_HATCH_WAIT_MS = 300_000;

type LocalHatchResult = Awaited<ReturnType<typeof hatchLocalAssistantHost>>;

// Module-level state so HMR remounts, StrictMode double-mounts, and the
// shell's session-driven remounts survive without spawning duplicate hatches.
// The remounted instance must await the SAME in-flight (or already-resolved)
// hatch — and reuse the SAME avatar traits — rather than start over. These
// guards are released only on failure (so retry re-hatches) and on genuine
// completion, never in the window between the hatch resolving and the screen
// navigating away.
let localHatchPromise: Promise<LocalHatchResult> | null = null;
// The hosting mode the held localHatchPromise was created with. A held promise
// only answers for the SAME mode: the guard can outlive a trip through the
// hosting screen, where the user may switch modes, and the abandoned mode's
// assistant must not be adopted for the new choice.
let localHatchRemote: string | undefined;
type PlatformHatchResult = Awaited<ReturnType<typeof hatchAssistant>>;
let platformHatchPromise: Promise<PlatformHatchResult> | null = null;
let hatchTraitsCache: CharacterTraits | null = null;

function releaseHatchGuards(): void {
  localHatchPromise = null;
  localHatchRemote = undefined;
  platformHatchPromise = null;
  hatchTraitsCache = null;
}

type HatchPhase = "initializing" | "provisioning" | "connecting" | "ready";

const PHASE_TARGET: Record<HatchPhase, number> = {
  initializing: 0,
  provisioning: 0.33,
  connecting: 0.66,
  ready: 1.0,
};

const SEGMENT_DURATION_MS = 1500;

// Written out per phase rather than composed from the phase name, so a phase
// added without its copy fails to compile and the key stays greppable for the
// orphan check in the catalog tests.
const PHASE_KEY: Record<HatchPhase, `hatchingScreen.phase.${HatchPhase}`> = {
  initializing: "hatchingScreen.phase.initializing",
  provisioning: "hatchingScreen.phase.provisioning",
  connecting: "hatchingScreen.phase.connecting",
  ready: "hatchingScreen.phase.ready",
};

export function interpolateSegmentProgress(
  segmentStart: number,
  target: number,
  elapsedMs: number,
): number {
  if (segmentStart >= target) {
    return target;
  }
  const t = Math.min(1.0, elapsedMs / SEGMENT_DURATION_MS);
  const eased = 1.0 - Math.pow(1.0 - t, 3.0);
  return segmentStart + (target - segmentStart) * eased;
}

/**
 * The funnel's provisioning step, ported from web's
 * `/assistant/onboarding/hatching` — now `/account/onboarding/hatching`,
 * rendered with the account screens' compact chrome.
 *
 * The local arm re-homes onto the shell bridge: the CLI hatch runs in the
 * shell's main process, and the daemon+gateway wait rides the bridge's status
 * probe. The pending provider key stays staged for the downstream apply (same
 * sessionStorage, same origin). Cloud hatches ride the app's own hatch API —
 * the route creates-or-reuses the row and provisions inline, so the POST's
 * answer IS the handoff, and the shell's resolution owns the not-ready states
 * afterwards.
 */
export function HatchingScreen() {
  const { t } = useTranslation("account");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const hostingParam = searchParams.get("hosting");
  const failParam = searchParams.get("fail");
  // Marketing plugin attribution, forwarded from the api-key step. The local
  // hatch is an intermediate route on the way to research, so carry it through
  // (see `plugin-attribution`) — otherwise a local/Docker onboarding drops it.
  const pluginParam = searchParams.get(ATTRIBUTED_PLUGIN_PARAM);
  const useLocalHatch =
    isLocalClient() && hostingParam !== null && hostingParam !== "cadet-cloud";
  const [hatchTraits] = useState<CharacterTraits>(
    () => (hatchTraitsCache ??= randomCharacterTraits(BUNDLED_COMPONENTS)),
  );
  const avatarSvgDataUrl = useMemo(() => {
    const svg = composeSvg(
      BUNDLED_COMPONENTS,
      hatchTraits.bodyShape,
      hatchTraits.eyeStyle,
      hatchTraits.color,
      320,
    );
    if (!svg) {
      return "";
    }
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }, [hatchTraits]);
  const [phase, setPhase] = useState<HatchPhase>("initializing");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [displayProgress, setDisplayProgress] = useState<number>(0);
  const [animationEpoch, setAnimationEpoch] = useState(0);

  const phaseRef = useRef<HatchPhase>(phase);
  const segmentStartRef = useRef(0);
  const segmentStartTimeRef = useRef(0);
  const displayProgressRef = useRef(0);

  const transitionPhase = useCallback((next: HatchPhase) => {
    segmentStartRef.current = displayProgressRef.current;
    segmentStartTimeRef.current = Date.now();
    phaseRef.current = next;
    setPhase(next);
    setAnimationEpoch((n) => n + 1);
  }, []);

  useEffect(() => {
    // Developer "Replay Hatch Failure" tool: when opened with `?fail`, skip
    // the real hatch flow and render the error UI directly so the failure
    // screen can be exercised on demand.
    if (failParam !== null) {
      setError(
        "Simulated hatch failure (developer menu → Replay Hatch Failure).",
      );
      return;
    }

    let cancelled = false;
    let navigateTimer: ReturnType<typeof setTimeout> | null = null;
    let readyPollTimer: ReturnType<typeof setTimeout> | null = null;
    const pollStartMs = Date.now();

    const handleHatchReady = (readyAssistantId?: string) => {
      // Seed the random hatch avatar for the freshly hatched assistant — the
      // D3b flagged gap, re-homed from web's seeding onto the app's scoped
      // surface. Read-then-write (never over an existing sidecar), never
      // awaited: the handoff below must not block on the server-side render,
      // and the research face step overwrites the avatar anyway when the user
      // picks one — this is the dock/tray stopgap during the research window.
      if (readyAssistantId) {
        void seedHatchAvatar(readyAssistantId, hatchTraits);
      }
      setDisplayProgress(1);
      displayProgressRef.current = 1;
      segmentStartRef.current = 1;
      setPhase("ready");
      phaseRef.current = "ready";
      navigateTimer = setTimeout(() => {
        if (cancelled) {
          return;
        }
        // The hatch succeeded and we're leaving this screen for good. Release
        // the module-level guards so a later onboarding session hatches a
        // brand-new one instead of reusing this resolved promise and avatar.
        releaseHatchGuards();
        void (async () => {
          // A local hatch feeds the research/personality flow. The assistant
          // is live, so the research route adopts it (its background hatch
          // resolves the existing local assistant instead of provisioning a
          // cloud one). The hosting choice carries through so research adopts
          // exactly this assistant, not whatever a stale selection resolves
          // to.
          if (useLocalHatch) {
            const researchParams = new URLSearchParams();
            if (hostingParam) {
              researchParams.set("hosting", hostingParam);
            }
            if (readyAssistantId) {
              researchParams.set("assistant", readyAssistantId);
            }
            if (pluginParam) {
              researchParams.set(ATTRIBUTED_PLUGIN_PARAM, pluginParam);
            }
            const researchQs = researchParams.toString();
            void navigate(
              `${routes.onboarding.research}${researchQs ? `?${researchQs}` : ""}`,
              SETUP_NAVIGATE,
            );
            return;
          }
          void navigate(routes.onboarding.research, SETUP_NAVIGATE);
        })();
      }, COMPLETION_NAVIGATE_DELAY_MS);
    };

    const startHatch = async () => {
      transitionPhase("provisioning");

      // Local/Docker hatch lifecycle: the bridge runs the CLI to spawn the
      // daemon + gateway, the lockfile reload discovers the new assistant, and
      // the status probe waits for it to answer before the handoff.
      if (useLocalHatch) {
        try {
          const remote = hostingParam === "docker" ? "docker" : undefined;
          // A promise held across a retry answers only for the hosting mode it
          // was created with; a switched mode hatches fresh.
          if (localHatchPromise && localHatchRemote !== remote) {
            releaseHatchGuards();
          }
          if (!localHatchPromise) {
            localHatchRemote = remote;
            localHatchPromise = hatchLocalAssistantHost(remote);
          }
          const result = await localHatchPromise;
          if (cancelled) {
            return;
          }
          if (!result.ok) {
            releaseHatchGuards();
            setError(result.error ?? "Failed to hatch local assistant.");
            return;
          }
          // Reload the lockfile so the just-written entry is visible to this
          // surface and the shell's own resolution before anything probes it.
          await readLockfileHost();
          if (result.assistantId) {
            writeSelectedAssistantId(result.assistantId);
          }
          // The CLI's hatch spawns the daemon + gateway as background
          // processes and exits before they finish starting up — wait for the
          // lifecycle probe to report healthy before handing off.
          transitionPhase("connecting");
          if (result.assistantId) {
            let gatewayReady = false;
            while (!cancelled && !gatewayReady) {
              const status = await statusLocalAssistantHost(result.assistantId);
              if (status.ok && status.state === "healthy") {
                gatewayReady = true;
                break;
              }
              if (Date.now() - pollStartMs >= MAX_HATCH_WAIT_MS) {
                // The hatch succeeded but the gateway never went healthy —
                // release the guards so "Try again" runs a genuinely fresh
                // hatch.
                releaseHatchGuards();
                setError(
                  "Your assistant is taking longer than expected. Please try again.",
                );
                return;
              }
              await new Promise<void>((resolve) => {
                readyPollTimer = setTimeout(resolve, POLL_INTERVAL_MS);
              });
              readyPollTimer = null;
            }
            if (cancelled) {
              return;
            }
          }
          handleHatchReady(result.assistantId);
        } catch {
          releaseHatchGuards();
          if (cancelled) {
            return;
          }
          setError(
            "Failed to hatch local assistant. Check CLI logs for details.",
          );
        }
        return;
      }

      // Cloud hatch. The cloud-hosted-disabled fallback is web-only chrome —
      // its CTA downloads the desktop app this bundle already runs in.
      try {
        if (!platformHatchPromise) {
          platformHatchPromise = hatchAssistant();
        }
        const result = await platformHatchPromise;
        platformHatchPromise = null;
        if (cancelled) {
          return;
        }
        if (result.ok) {
          handleHatchReady(result.data.id);
          return;
        }
        console.warn("Onboarding hatch request failed", {
          status: result.status,
          error: result.error,
        });
        setError(
          result.error.detail ||
            "Failed to start your assistant. Please try again.",
        );
      } catch (err) {
        platformHatchPromise = null;
        captureError(err, { context: "onboarding_hatch_assistant" });
        if (cancelled) {
          return;
        }
      }
    };

    void startHatch();

    return () => {
      cancelled = true;
      if (navigateTimer) {
        clearTimeout(navigateTimer);
      }
      if (readyPollTimer) {
        clearTimeout(readyPollTimer);
      }
    };
  }, [
    attempt,
    failParam,
    hatchTraits,
    navigate,
    transitionPhase,
    useLocalHatch,
  ]);

  useEffect(() => {
    if (segmentStartTimeRef.current === 0) {
      segmentStartTimeRef.current = Date.now();
    }
    let rafId: number;
    const tick = () => {
      const elapsed = Date.now() - segmentStartTimeRef.current;
      const target = PHASE_TARGET[phaseRef.current];
      const value = interpolateSegmentProgress(
        segmentStartRef.current,
        target,
        elapsed,
      );
      displayProgressRef.current = value;
      setDisplayProgress(value);
      if (target - value > 1e-6) {
        rafId = requestAnimationFrame(tick);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [animationEpoch]);

  if (error) {
    return (
      <AccountShell>
        <div
          role="alert"
          className="flex w-full flex-col items-center text-center text-[var(--content-default)]"
        >
          <h1 className="text-3xl font-semibold tracking-tight">
            {t("hatchingScreen.genericFailure")}
          </h1>
          <p className="mt-3 text-body-medium-lighter text-[var(--content-tertiary)]">
            {error}
          </p>
          <img
            src={avatarSvgDataUrl}
            alt=""
            width={160}
            height={160}
            className="my-10"
          />
          <div className="flex w-full flex-col gap-2">
            <Button
              variant="primary"
              size="large"
              fullWidth
              onClick={() => {
                segmentStartRef.current = 0;
                segmentStartTimeRef.current = Date.now();
                phaseRef.current = "initializing";
                displayProgressRef.current = 0;
                setPhase("initializing");
                setDisplayProgress(0);
                setAnimationEpoch((n) => n + 1);
                setError(null);
                setAttempt((n) => n + 1);
              }}
            >
              {t("actions.tryAgain")}
            </Button>
            <Button
              variant="outlined"
              size="large"
              fullWidth
              onClick={() => {
                const to = useLocalHatch
                  ? routes.account.onboarding.hosting
                  : `${routes.onboarding.research}?${NEW_ASSISTANT_PARAM}=1`;
                void navigate(to, SETUP_NAVIGATE);
              }}
            >
              {t("actions.back")}
            </Button>
          </div>
        </div>
      </AccountShell>
    );
  }

  return (
    <AccountShell>
      <div className="flex w-full flex-col items-center text-center text-[var(--content-default)]">
        <h1 className="text-3xl font-semibold tracking-tight">
          {phase === "ready"
            ? t("hatchingScreen.ready")
            : t("hatchingScreen.waking")}
        </h1>
        {phase !== "ready" && (
          <p className="mt-3 text-body-medium-lighter text-[var(--content-tertiary)]">
            {t("hatchingScreen.wakingBody")}
          </p>
        )}
        <img
          src={avatarSvgDataUrl}
          alt=""
          width={160}
          height={160}
          className={`my-10 ${phase === "ready" ? "" : "animate-pulse"}`}
        />
        <ProgressBar
          value={displayProgress}
          height={6}
          className="w-full"
          aria-label={t("hatchingScreen.progressAriaLabel")}
        />
        <p className="mt-3 text-body-small-default text-[var(--content-tertiary)]">
          {t(PHASE_KEY[phase])}
        </p>
      </div>
    </AccountShell>
  );
}
