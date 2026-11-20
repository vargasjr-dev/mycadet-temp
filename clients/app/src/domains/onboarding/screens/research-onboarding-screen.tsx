/**
 * Research-onboarding front door — collects name and role, then
 * hands off to the assistant to research the person.
 *
 * SPIKE — research-onboarding flow.
 *
 * Presentational only: owns local field state and validation, delegates the
 * context build + handoff navigation to the caller via `onSubmit`.
 */

import { useState } from "react";
import { ArrowRight } from "lucide-react";

import { OnboardingEdgeCharacters } from "@app/domains/onboarding/components/onboarding-edge-characters";
import { OnboardingLayout } from "@app/components/onboarding-layout";
import { Button } from "@mycadet/design-library/components/button";
import { Input } from "@mycadet/design-library/components/input";

import {
  MOBILE_INPUT_NO_ZOOM,
  ONBOARDING_DARK_SURFACE,
} from "@app/domains/onboarding/onboarding-step-layout";
import { usePublishPageSurface } from "@app/stores/page-surface-store";
import { useTranslation } from "@app/i18n";

export interface ResearchOnboardingValues {
  firstName: string;
}

interface ResearchOnboardingScreenProps {
  initialFirstName?: string;
  onSubmit: (values: ResearchOnboardingValues) => void;
  /** The faint off-ramp: abandoning the funnel for the assistant as-is. */
  onSkip: () => void;
}

/**
 * One animation cadence so every element rises in the same staggered rhythm.
 *
 * The descending `zIndex` keeps each field (and its absolutely-positioned
 * autocomplete dropdown) painting above the rows below it: the entrance
 * `animation` makes every row its own stacking context, so a later row would
 * otherwise cover an earlier row's open dropdown.
 */
function riseIn(delaySeconds: number, zIndex?: number): React.CSSProperties {
  return {
    animation: `fadeInUp 0.4s ease-out ${delaySeconds}s both`,
    ...(zIndex != null ? { position: "relative", zIndex } : {}),
  };
}

export function ResearchOnboardingScreen({
  initialFirstName = "",
  onSubmit,
  onSkip,
}: ResearchOnboardingScreenProps) {
  const { t } = useTranslation("onboarding");
  // The screen owns the whole viewport, so the shell paints its safe-area
  // strips to match. See `page-surface-store`.
  usePublishPageSurface(ONBOARDING_DARK_SURFACE);
  const [firstName, setFirstName] = useState(initialFirstName);

  const canSubmit = firstName.trim().length > 0;

  function handleSubmit() {
    if (!canSubmit) {
      return;
    }
    onSubmit({ firstName });
  }

  return (
    // Force the dark palette for the onboarding flow regardless of app theme —
    // `data-theme="dark"` re-declares the design tokens for this subtree (custom
    // props inherit down). Matches the brand onboarding design.
    <div data-theme="dark" className="h-full">
      <OnboardingLayout showCreatureFooter={false}>
        <OnboardingEdgeCharacters />
        <form
          className="relative z-10 mx-auto flex min-h-screen w-full max-w-sm flex-col items-center justify-center px-6 py-16 text-[var(--content-default)]"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <h1
            className="text-center font-serif text-[2.75rem] leading-[1.05] tracking-tight"
            style={riseIn(0.05)}
          >
            {t("researchOnboardingScreen.title")}
          </h1>

          <div className="mt-10 flex w-full flex-col gap-5">
            <div style={riseIn(0.12, 40)}>
              <Input
                label={t("researchOnboardingScreen.firstNameLabel")}
                placeholder={t("researchOnboardingScreen.firstNamePlaceholder")}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className={MOBILE_INPUT_NO_ZOOM}
                autoFocus
                required
                fullWidth
              />
            </div>
          </div>

          <div className="mt-10 w-full" style={riseIn(0.5)}>
            <Button
              type="submit"
              variant="primary"
              size="large"
              rightIcon={<ArrowRight size={16} />}
              fullWidth
              disabled={!canSubmit}
            >
              {t("actions.continue")}
            </Button>
          </div>
        </form>

        {/* The off-ramp: faint on purpose — findable, never competing with
            the funnel. Fixed to the viewport corner so it holds its ground
            no matter how the centered column reflows. */}
        <button
          type="button"
          onClick={onSkip}
          className="fixed right-6 bottom-6 text-body-small text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-secondary)]"
          style={riseIn(0.6)}
        >
          {t("researchOnboardingScreen.skip")}
        </button>
      </OnboardingLayout>
    </div>
  );
}
