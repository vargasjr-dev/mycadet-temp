import { SkillsReferenceScreenWatchContent } from "@/app/docs/_components/skills-reference-screen-watch-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Screen Watch - Cadet Docs",
  description:
    "Screen Watch skill for Cadet — observe your screen at regular intervals with OCR for context-aware assistance.",
  path: "/docs/skills-reference/screen-watch",
});

export default function SkillsReferenceScreenWatchPage() {
  return <SkillsReferenceScreenWatchContent />;
}
