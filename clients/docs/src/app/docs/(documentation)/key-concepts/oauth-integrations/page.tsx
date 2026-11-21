import { MarkdownDoc } from "@/app/docs/_components/markdown-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "OAuth Integrations - Cadet Docs",
  description:
    "How Cadet connects to third-party services via OAuth2, what services are supported, and how your credentials stay secure.",
  path: "/docs/key-concepts/oauth-integrations",
});

export default function OauthIntegrationsPage() {
  return (
    <MarkdownDoc
      file="key-concepts/oauth-integrations"
      title="OAuth Integrations"
      breadcrumb="Docs / Key Concepts / OAuth Integrations"
    />
  );
}
