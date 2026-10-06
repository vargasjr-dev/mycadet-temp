import { WebSearchSerplyContent } from "@/app/docs/_components/web-search-serply-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Serply - Web Search - Cadet Docs",
  description:
    "How to connect Serply as your web search provider in Cadet: API key setup, provider configuration, and usage.",
  path: "/docs/key-concepts/web-search/serply",
});

export default function SerplyPage() {
  return <WebSearchSerplyContent />;
}
