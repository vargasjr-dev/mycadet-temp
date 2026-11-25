import { RoadmapContent } from "@/app/docs/_components/roadmap-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Roadmap | Cadet",
  description:
    "What's coming to Cadet — shipping soon, up next, on the horizon, and what we're exploring.",
  path: "/roadmap",
});

export default function RoadmapPage() {
  return <RoadmapContent />;
}
