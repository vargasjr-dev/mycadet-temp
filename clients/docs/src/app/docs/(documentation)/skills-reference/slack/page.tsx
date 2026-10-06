import { SkillsReferenceSlackContent } from "@/app/docs/_components/skills-reference-slack-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Slack - Cadet Docs",
  description:
    "Slack skill for Cadet — scan channels, summarize threads, manage reactions, and configure privacy-aware integration.",
  path: "/docs/skills-reference/slack",
});

export default function SkillsReferenceSlackPage() {
  return <SkillsReferenceSlackContent />;
}
