import { SkillsReferenceSkillManagementContent } from "@/app/docs/_components/skills-reference-skill-management-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Skill Management - Cadet Docs",
  description:
    "Skill Management skill for Cadet — creates and deletes custom managed skills to extend your assistant.",
  path: "/docs/skills-reference/skill-management",
});

export default function SkillsReferenceSkillManagementPage() {
  return <SkillsReferenceSkillManagementContent />;
}
