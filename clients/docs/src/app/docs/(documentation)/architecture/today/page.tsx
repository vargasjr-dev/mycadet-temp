import { MarkdownDoc } from "@/app/docs/_components/markdown-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Today's Architecture - Cadet Docs",
  description: "How your Cadet and the broader ecosystem works today.",
  path: "/docs/architecture/today",
});

export default function ArchitectureTodayPage() {
  return (
    <MarkdownDoc
      file="architecture/today"
      title="Today's Architecture"
      breadcrumb="Docs / Architecture / Today"
    />
  );
}
