import { HomepageContent } from "@/app/docs/_components/homepage-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Homepage - Cadet Docs",
  description:
    "Cadet documentation — guides, tutorials, and references for building your personal AI assistant.",
  path: "/docs",
});

export default function DocsPage() {
  return <HomepageContent />;
}
