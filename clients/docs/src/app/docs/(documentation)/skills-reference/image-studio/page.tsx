import { SkillsReferenceImageStudioContent } from "@/app/docs/_components/skills-reference-image-studio-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Image Studio - Cadet Docs",
  description:
    "Image Studio skill for Cadet — generate and edit images using AI through your assistant.",
  path: "/docs/skills-reference/image-studio",
});

export default function SkillsReferenceImageStudioPage() {
  return <SkillsReferenceImageStudioContent />;
}
