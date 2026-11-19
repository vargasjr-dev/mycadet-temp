import { MarkdownDoc } from "@/app/docs/_components/markdown-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "North Star Architecture - Cadet Docs",
  description:
    "The end state that we are building every Cadet and the ecosystem at large towards.",
  path: "/docs/architecture/north-star",
});

export default function ArchitectureNorthStarPage() {
  return (
    <MarkdownDoc
      file="architecture/north-star"
      title="North Star Architecture"
      breadcrumb="Docs / Architecture / North star"
    />
  );
}
