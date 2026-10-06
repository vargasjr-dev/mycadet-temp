import { SkillsReferenceMediaProcessingContent } from "@/app/docs/_components/skills-reference-media-processing-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Media Processing - Cadet Docs",
  description:
    "Media Processing skill for Cadet — processes video, audio, and image files through a multi-phase AI pipeline.",
  path: "/docs/skills-reference/media-processing",
});

export default function SkillsReferenceMediaProcessingPage() {
  return <SkillsReferenceMediaProcessingContent />;
}
