import { InternalDoc } from "@/app/docs/_components/internal-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Scheduling Architecture - Cadet Docs",
  description: "How the assistant schedules work — heartbeats, wake intents, and task queues.",
  path: "/docs/developer-guide/internals/scheduling",
});

export default function SchedulingPage() {
  return <InternalDoc slug="scheduling" title="Scheduling Architecture" />;
}
