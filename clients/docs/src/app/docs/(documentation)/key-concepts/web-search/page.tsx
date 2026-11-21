import { MarkdownDoc } from "@/app/docs/_components/markdown-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Web Search | Cadet Docs",
  description:
    "How your assistant looks things up online: the six built-in providers, the fallback chain, and how each one is billed.",
  path: "/docs/key-concepts/web-search",
});

export default function WebSearchPage() {
  return (
    <MarkdownDoc
      file="key-concepts/web-search"
      title="Web Search"
      breadcrumb="Docs / Key Concepts / Web Search"
    />
  );
}
