import { InternalDoc } from "@/app/docs/_components/internal-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Assistant Architecture - Cadet Docs",
  description: "Runtime internals — conversation loop, tool dispatch, memory, scheduling, and the daemon boundary.",
  path: "/docs/developer-guide/internals/assistant-architecture",
});

export default function AssistantArchitecturePage() {
  return <InternalDoc slug="assistant-architecture" title="Assistant Architecture" />;
}
