import { ArchitectureNorthStarContent } from "@/app/docs/_components/architecture-north-star-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "North Star Architecture - Cadet Docs",
  description:
    "Where Cadet is going: a hardened core beside a disposable workbench, and why that split keeps your assistant safe.",
  path: "/docs/architecture/north-star",
});

export default function ArchitectureNorthStarPage() {
  return <ArchitectureNorthStarContent />;
}
