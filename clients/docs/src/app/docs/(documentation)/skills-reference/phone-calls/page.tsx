import { SkillsReferencePhoneCallsContent } from "@/app/docs/_components/skills-reference-phone-calls-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Phone Calls - Cadet Docs",
  description:
    "Phone Calls skill for Cadet — make and receive calls via Twilio with real-time voice conversation and transcription.",
  path: "/docs/skills-reference/phone-calls",
});

export default function SkillsReferencePhoneCallsPage() {
  return <SkillsReferencePhoneCallsContent />;
}
