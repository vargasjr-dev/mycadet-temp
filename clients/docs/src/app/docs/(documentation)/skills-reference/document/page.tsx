import { SkillsReferenceDocumentContent } from "@/app/docs/_components/skills-reference-document-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Document - Cadet Docs",
  description:
    "Document skill for Cadet — create and edit long-form text in a dedicated rich-text editor with Markdown support.",
  path: "/docs/skills-reference/document",
});

export default function SkillsReferenceDocumentPage() {
  return <SkillsReferenceDocumentContent />;
}
