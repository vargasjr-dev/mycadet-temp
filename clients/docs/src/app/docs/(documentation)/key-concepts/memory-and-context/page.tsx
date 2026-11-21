import { MarkdownDoc } from "@/app/docs/_components/markdown-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Memory & Context | Cadet Docs",
  description:
    "How Cadet memory carries knowledge across conversations — what it keeps, how it's captured, organized, and recalled.",
  path: "/docs/key-concepts/memory-and-context",
});

export default function MemoryAndContextPage() {
  return (
    <MarkdownDoc
      file="key-concepts/memory-and-context"
      title="Memory & Context"
      breadcrumb="Docs / Key Concepts / Memory & Context"
    />
  );
}
