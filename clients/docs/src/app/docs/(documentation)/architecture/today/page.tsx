import { DeveloperGuideArchitectureContent } from "@/app/docs/_components/developer-guide-architecture-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Today's Architecture - Cadet Docs",
  description:
    "Platform domains, repository structure, and how the runtime, clients, and gateway fit together.",
  path: "/docs/architecture/today",
});

export default function ArchitectureTodayPage() {
  return <DeveloperGuideArchitectureContent />;
}
