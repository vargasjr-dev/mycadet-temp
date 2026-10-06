import { OauthIntegrationsContent } from "@/app/docs/_components/oauth-integrations-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "OAuth Integrations - Cadet Docs",
  description:
    "How Cadet connects to third-party services via OAuth2: supported services, how the credential vault works, security model, and troubleshooting.",
  path: "/docs/key-concepts/oauth-integrations",
});

export default function OauthIntegrationsPage() {
  return <OauthIntegrationsContent />;
}
