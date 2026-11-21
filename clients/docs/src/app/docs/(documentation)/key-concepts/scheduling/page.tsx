import { MarkdownDoc } from "@/app/docs/_components/markdown-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Scheduling - Cadet Docs",
  description:
    "How your assistant works on its own clock: one-shot schedules, recurring cadences, heartbeats, watchers, and playbooks.",
  path: "/docs/key-concepts/scheduling",
});

export default function SchedulingPage() {
  return (
    <MarkdownDoc
      file="key-concepts/scheduling"
      title="Scheduling"
      breadcrumb="Docs / Key Concepts / Scheduling"
    />
  );
}
