import { InternalDoc } from "@/app/docs/_components/internal-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Architecture - Cadet Docs",
  description: "Cross-system map of the Cadet repo — invariants, domain boundaries, data flow, and the local/managed hosting split.",
  path: "/docs/developer-guide/internals/architecture",
});

export default function ArchitecturePage() {
  return <InternalDoc slug="architecture" title="Architecture" />;
}
