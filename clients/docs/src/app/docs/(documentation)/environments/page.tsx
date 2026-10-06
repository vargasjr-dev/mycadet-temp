import { EnvironmentsContent } from "@/app/docs/_components/environments-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Environments - Cadet Docs",
  description:
    "Choose a deployment environment for Cadet: Cadet Cloud (recommended), local, or user-hosted (GCP or a custom Linux host), with trade-offs for each.",
  path: "/docs/environments",
});

export default function EnvironmentsPage() {
  return <EnvironmentsContent />;
}
