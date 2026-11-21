import { MarkdownDoc } from "@/app/docs/_components/markdown-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Model Profiles | Cadet Docs",
  description:
    "Control which LLM your assistant uses for each job — conversations, memory work, scheduled tasks — and override it per call-site when you need to.",
  path: "/docs/key-concepts/model-profiles",
});

export default function ModelProfilesPage() {
  return (
    <MarkdownDoc
      file="key-concepts/model-profiles"
      title="Model Profiles"
      breadcrumb="Docs / Key Concepts / Model Profiles"
    />
  );
}
