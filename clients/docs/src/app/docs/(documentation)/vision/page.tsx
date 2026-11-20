import { MarkdownDoc } from "@/app/docs/_components/markdown-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Vision - Cadet Docs",
  description:
    "The end state that we are building every Cadet and the ecosystem at large towards.",
  path: "/docs/vision",
});

export default function VisionPage() {
  return (
    <MarkdownDoc file="vision" title="Vision" breadcrumb="Docs / Vision" />
  );
}
