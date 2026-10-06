import { IntegrationsTavilyContent } from "@/app/docs/_components/integrations-tavily-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Tavily - Web Search - Cadet Docs",
  description:
    "How to connect Tavily as your web search provider in Cadet: API key setup, provider configuration, and usage.",
  path: "/docs/key-concepts/web-search/tavily",
});

export default function TavilyPage() {
  return <IntegrationsTavilyContent />;
}
