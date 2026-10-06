import { InternalDoc } from "@/app/docs/_components/internal-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Turn Actor Architecture - Cadet Docs",
  description: "The turn-actor model — how a conversation turn is routed and executed.",
  path: "/docs/developer-guide/internals/turn-actor",
});

export default function TurnActorPage() {
  return <InternalDoc slug="turn-actor" title="Turn Actor Architecture" />;
}
