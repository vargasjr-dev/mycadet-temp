import { SkillsReferenceFollowupsContent } from "@/app/docs/_components/skills-reference-followups-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Followups - Cadet Docs",
  description:
    "Followups skill for Cadet — tracks messages awaiting responses across all communication channels.",
  path: "/docs/skills-reference/followups",
});

export default function SkillsReferenceFollowupsPage() {
  return <SkillsReferenceFollowupsContent />;
}
