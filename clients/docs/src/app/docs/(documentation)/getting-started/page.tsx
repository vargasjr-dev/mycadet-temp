import { MarkdownDoc } from "@/app/docs/_components/markdown-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Getting Started - Cadet Docs",
  description:
    "Get started with Cadet: what Cadet is, installation, a quick start guide, and your first skill — all in one place.",
  path: "/docs/getting-started",
});

export default function GettingStartedPage() {
  return (
    <MarkdownDoc
      file="getting-started"
      title="Getting Started"
      breadcrumb="Docs / Getting Started"
    />
  );
}
