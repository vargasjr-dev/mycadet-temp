import { WebSearchExaContent } from "@/app/docs/_components/web-search-exa-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Exa - Web Search - Cadet Docs",
  description:
    "How to connect Exa as your web search provider in Cadet: API key setup, provider configuration, and usage.",
  path: "/docs/key-concepts/web-search/exa",
});

export default function ExaPage() {
  return <WebSearchExaContent />;
}
