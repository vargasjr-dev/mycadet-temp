import { SchedulingContent } from "@/app/docs/_components/scheduling-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Scheduling - Cadet Docs",
  description:
    "How scheduling and automation work in Cadet — one-shot and recurring schedules, heartbeats, watchers, playbooks, and proactive background work.",
  path: "/docs/key-concepts/scheduling",
});

export default function SchedulingPage() {
  return <SchedulingContent />;
}
