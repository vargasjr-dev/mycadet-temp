import { MarkdownDoc } from "@/app/docs/_components/markdown-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Key Concepts - Cadet Docs",
  description:
    "Core Cadet concepts — workspace, skills and tools, memory and context, channels, assistant identity, and glossary.",
  path: "/docs/key-concepts",
});

export default function KeyConceptsIndexPage() {
  return (
    <MarkdownDoc
      file="key-concepts"
      title="Key Concepts"
      breadcrumb="Docs / Key Concepts"
      navCards
    />
  );
}
