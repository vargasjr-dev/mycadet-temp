import { KeyConceptsContent } from "@/app/docs/_components/key-concepts-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Key Concepts - Cadet Docs",
  description:
    "Core Cadet concepts — workspace, skills and tools, memory and context, channels, assistant identity, and glossary.",
  path: "/docs/key-concepts",
});

export default function KeyConceptsPage() {
  return <KeyConceptsContent />;
}
