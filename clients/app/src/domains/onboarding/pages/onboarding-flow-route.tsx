import { useState } from "react";
import { z } from "zod";
import { useNavigate, useSearchParams } from "react-router";
import { patchCloud } from "@app/lib/cloud/request";
import { saveCharacterTraits } from "@app/assistant/avatar-traits";
import { resolveOrganization } from "@app/lib/cloud/organization";
import { buildLetsChatKickoffMessage } from "@app/domains/onboarding/lets-chat-kickoff";
import {
  setPendingAssistantName,
  setPendingPreChatContext,
  type PreChatOnboardingContext,
} from "@app/domains/onboarding/prechat";
import { markAssistantOnboarded } from "@app/domains/onboarding/onboarded-assistant-record";
import { OnboardingLayout } from "@app/components/onboarding-layout";
import { routes } from "@app/utils/routes";
import { ResearchOnboardingScreen } from "../screens/research-onboarding-screen";
import { IntroductionScreen } from "../screens/introduction-screen";
import { GiveMeAFaceScreen } from "../screens/give-me-a-face-screen";
import type { GiveMeAFaceValues } from "../screens/give-me-a-face-screen";
import type { ResearchOnboardingValues } from "../screens/research-onboarding-screen";

/**
 * The onboarding funnel's post-hatch steps, served at
 * `/assistant/onboarding/research` — the route path web's research flow owned
 * before the product ruling dropped the research turn entirely.
 *
 * The surviving funnel: who are you (form) → meet your assistant (intro) →
 * give me a face (avatar + voice) → handoff into a fresh chat with a hidden
 * kickoff. Everything that ran daemon turns is gone: the research runner, the
 * plugin pre-install, the personality rewrite, and the pre-chat profile
 * upserting. Whatever the assistant wants to know about itself, it learns from
 * the handoff context riding the first chat message — and writes itself, on
 * hatch or wake or its own onboarding, if it chooses to.
 */

/** The sub-steps the funnel sequences through. */
type FlowStep = "form" | "intro" | "face";

/**
 * Persists the avatar's voice to the assistant's managed-TTS config. Onboarding
 * assistants are managed, so the voice lives on the `cadet` provider block,
 * the same field every voice picker writes. A null voice is a no-op: the
 * catalog never loaded, so the assistant keeps the cloud default.
 */
async function saveAvatarVoice(
  assistantId: string,
  model: string | null,
): Promise<void> {
  if (!model) {
    return;
  }
  const organization = await resolveOrganization();
  if (!organization.ok) {
    return;
  }
  // The config PATCH rides the app's cloud proxy; the body matches the
  // daemon's config patch shape (services.tts.providers.cadet.model).
  await patchCloud(
    `/v1/assistants/${encodeURIComponent(assistantId)}/config`,
    z.null(),
    { services: { tts: { providers: { cadet: { model } } } } },
    { organizationId: organization.data },
  ).catch(() => undefined);
}

export function OnboardingFlowRoute() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // The hatching screen hands off only once provisioning is ready, so the id
  // is already live here — no hatch-wait, no error overlay, no retry arm.
  const assistantId = searchParams.get("assistant");

  const [step, setStep] = useState<FlowStep>("form");
  const [formValues, setFormValues] = useState<ResearchOnboardingValues | null>(
    null,
  );
  const [faceValues, setFaceValues] = useState<GiveMeAFaceValues | null>(null);

  function goBack() {
    setStep((current) =>
      current === "face" ? "intro" : current === "intro" ? "form" : current,
    );
  }

  /**
   * Build the pre-chat context and hand off into a fresh chat. The hidden
   * kickoff drives the assistant's first reply without rendering a user
   * bubble, so the chat opens with a proactive greeting in the persona the
   * user just configured; the chosen name rides both the context and the
   * optimistic sidebar hint.
   */
  function enterAssistant() {
    if (!formValues) {
      return;
    }
    const fullName = [formValues.firstName.trim(), formValues.lastName.trim()]
      .filter(Boolean)
      .join(" ");
    const assistantName = faceValues?.name.trim() || undefined;

    const context: PreChatOnboardingContext = {
      // No tool/task collection in this flow.
      tools: [],
      tasks: [],
      tone: "grounded",
      ...(fullName ? { userName: fullName } : {}),
      ...(formValues.role.trim() ? { occupation: formValues.role.trim() } : {}),
      // Hidden kickoff: the chat opens on the assistant's proactive greeting.
      initialMessage: buildLetsChatKickoffMessage(assistantName),
      initialMessageHidden: true,
      ...(assistantName ? { assistantName } : {}),
    };
    setPendingPreChatContext(context);
    if (assistantName) {
      setPendingAssistantName(assistantName);
    }

    if (assistantId) {
      // The completion record this assistant is judged by from here on.
      markAssistantOnboarded(assistantId);
      // Apply the picked avatar now — the assistant is hatched, so the traits
      // land directly (no staged handoff for a later chat mount to consume).
      if (faceValues) {
        void saveCharacterTraits(assistantId, faceValues.traits).then(() =>
          saveAvatarVoice(assistantId, faceValues.voiceModel),
        );
      }
    }

    void navigate(`${routes.assistant}?onboarding=1`, { replace: true });
  }

  if (step === "form") {
    return (
      <OnboardingLayout avatarWave="none">
        <ResearchOnboardingScreen
          onSubmit={(values) => {
            setFormValues(values);
            setStep("intro");
          }}
        />
      </OnboardingLayout>
    );
  }

  if (step === "intro" && formValues) {
    return (
      <OnboardingLayout avatarWave="none">
        <IntroductionScreen
          firstName={formValues.firstName.trim()}
          assistantName={faceValues?.name.trim() || undefined}
          onContinue={() => setStep("face")}
          onBack={goBack}
        />
      </OnboardingLayout>
    );
  }

  if (step === "face" && formValues) {
    return (
      <OnboardingLayout avatarWave="none">
        <GiveMeAFaceScreen
          initialName={faceValues?.name}
          onContinue={(values) => {
            setFaceValues(values);
            enterAssistant();
          }}
          onBack={goBack}
        />
      </OnboardingLayout>
    );
  }

  // Unreachable in practice (formValues is set before the steps that need it);
  // the fallback keeps the narrowing honest.
  return null;
}
