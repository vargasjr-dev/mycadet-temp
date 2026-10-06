import { InternalDoc } from "@/app/docs/_components/internal-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Integrations Architecture - Cadet Docs",
  description: "How third-party integrations (OAuth2 skills, channels, and plugins) attach to the assistant.",
  path: "/docs/developer-guide/internals/integrations",
});

export default function IntegrationsPage() {
  return <InternalDoc slug="integrations" title="Integrations Architecture" />;
}
