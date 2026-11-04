import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { seedHatchAvatar } from "@app/assistant/avatar-traits";
import { hatchAssistant, releaseHatchGuard } from "@app/assistant/operations";
import { resolveAssistant } from "@app/assistant/resolve-assistant";
import { writeSelectedAssistantId } from "@app/assistant/selected-assistant-storage";
import { AccountShell } from "@app/components/account/account-shell";
import { NEW_ASSISTANT_PARAM } from "@app/domains/onboarding/onboarding-destination";
import { SETUP_NAVIGATE } from "@app/domains/onboarding/onboarding-navigation";
import { useTranslation } from "@app/i18n";
import { routes } from "@app/utils/routes";
import { Button } from "@mycadet/design-library/components/button";
import { ProgressBar } from "@mycadet/design-library/components/progress-bar";
import { RemoteSchema } from "@mycadet/local-mode/contract";
import type { CharacterTraits } from "@app/types/avatar";
import { BUNDLED_COMPONENTS } from "@app/utils/avatar-bundled-components";
import { randomCharacterTraits } from "@app/utils/avatar-random";
import { composeSvg } from "@app/utils/avatar-svg-compositor";

const COMPLETION_NAVIGATE_DELAY_MS = 800;

// Web's hatch-wait constants, inlined until the state core re-home gives them
// a shared package home. A local hatch waits out the CLI's background
// daemon+gateway startup before handing off.
const POLL_INTERVAL_MS = 3000;
const MAX_HATCH_WAIT_MS = 300_000;

type HatchResult = Awaited<ReturnType<typeof hatchAssistant>>;

// The hatch promise's coalescing lives in the operation (module-level there);
// this screen holds only the avatar traits so every remount riding the same
// hatch renders the SAME assistant. Released on failure (a retry regenerates)
// and on genuine completion — never in the window between the hatch resolving
// and the screen navigating away.
let hatchTraitsCache: CharacterTraits | null = null;

function releaseHatchTraits(): void {
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
 * The hatch rides the app bundle's one hatch api — POST /v1/assistants/hatch
 * with the funnel's hosting choice as the remote param. The hatch operation
 * discriminates (local, docker, cloud), so this screen never branches on the
 * mode: it waits the answer out, polls the resolution endpoint until the
 * hatched assistant answers, and hands off to research. The pending provider
 * key stays staged for the downstream apply (same sessionStorage, same
 * origin), and the shell's resolution owns the not-ready states afterwards.
 */
export function HatchingScreen() {
  const { t } = useTranslation("account");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // The funnel's hosting choice IS a Remote (the hosting screen emits the
  // contract's spelling) — validate the param and ride it as the hatch's
  // remote; anything absent or foreign reads as the local walk.
  const hosting = RemoteSchema.safeParse(searchParams.get("hosting")).data;
  const failParam = searchParams.get("fail");
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
        releaseHatchGuard();
        releaseHatchTraits();
        // A local walk carries the hosting choice + the hatched assistant so
        // research adopts exactly this assistant, not whatever a stale
        // selection resolves to (its background hatch resolves the existing
        // local assistant instead of provisioning a cloud one). A cloud walk
        // hands off bare — research owns the managed background hatch.
        if (hosting && hosting !== "cloud") {
          const researchParams = new URLSearchParams({ hosting });
          if (readyAssistantId) {
            researchParams.set("assistant", readyAssistantId);
          }
          void navigate(
            `${routes.onboarding.research}?${researchParams.toString()}`,
            SETUP_NAVIGATE,
          );
          return;
        }
        void navigate(routes.onboarding.research, SETUP_NAVIGATE);
      }, COMPLETION_NAVIGATE_DELAY_MS);
    };

    const startHatch = async () => {
      transitionPhase("provisioning");

      try {
        // The validated hosting choice IS the hatch api's remote param — the
        // hatch operation discriminates (local, docker, cloud), so this
        // screen never branches on the mode.
        const remote = hosting ?? "local";
        const result = await hatchAssistant(remote);
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          releaseHatchTraits();
          setError(result.error ?? "Failed to hatch your assistant.");
          return;
        }
        if (result.assistantId) {
          writeSelectedAssistantId(result.assistantId);
        }
        // The hatch's answer carries the new assistant; the resolution
        // poll below waits for it to answer before the handoff.
        transitionPhase("connecting");
        if (result.assistantId) {
          let gatewayReady = false;
          while (!cancelled && !gatewayReady) {
            // The resolution endpoint is the lifecycle read: the serving
            // host composes the entry's health and auth into the union, so
            // "ready" means the gateway is answering. A probe that cannot
            // settle (transport error, timeout) keeps polling within the
            // deadline below.
            const resolution = await resolveAssistant({
              signal: AbortSignal.timeout(10_000),
            }).catch(() => null);
            if (resolution?.status === "ready") {
              gatewayReady = true;
              break;
            }
            if (Date.now() - pollStartMs >= MAX_HATCH_WAIT_MS) {
              // The hatch succeeded but the assistant never went healthy —
              // release the guards so "Try again" runs a genuinely fresh
              // hatch.
              releaseHatchGuard();
              releaseHatchTraits();
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
        releaseHatchTraits();
        if (cancelled) {
          return;
        }
        setError("Failed to hatch your assistant. Please try again.");
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
  }, [attempt, failParam, hatchTraits, hosting, navigate, transitionPhase]);

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
                // The hosting choice is the walk's data: a local/docker walk
                // backs up to its hosting step; a cloud walk came through
                // research and returns there.
                const to =
                  hosting && hosting !== "cloud"
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
