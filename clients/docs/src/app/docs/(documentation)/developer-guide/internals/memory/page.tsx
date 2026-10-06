import { InternalDoc } from "@/app/docs/_components/internal-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Memory Architecture - Cadet Docs",
  description: "Memory system — extraction, recall, and provenance gates.",
  path: "/docs/developer-guide/internals/memory",
});

export default function MemoryPage() {
  return <InternalDoc slug="memory" title="Memory Architecture" />;
}
