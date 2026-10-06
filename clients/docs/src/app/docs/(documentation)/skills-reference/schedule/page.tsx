import { SkillsReferenceScheduleContent } from "@/app/docs/_components/skills-reference-schedule-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Schedule - Cadet Docs",
  description:
    "Schedule skill for Cadet — recurring and one-shot scheduled actions using cron syntax, RRULE patterns, or simple timestamps.",
  path: "/docs/skills-reference/schedule",
});

export default function SkillsReferenceSchedulePage() {
  return <SkillsReferenceScheduleContent />;
}
