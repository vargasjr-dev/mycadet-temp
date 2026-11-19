import { MarkdownDoc } from "@/app/docs/_components/markdown-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Homepage - Cadet Docs",
  description:
    "Cadet documentation — guides, tutorials, and references for building your personal AI assistant.",
  path: "/docs",
});

export default function DocsPage() {
  return (
    <MarkdownDoc
      file="homepage"
      title="Meet Cadet"
      breadcrumb="Docs / Homepage"
    />
  );
}
