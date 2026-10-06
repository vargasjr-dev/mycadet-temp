import { InternalDoc } from "@/app/docs/_components/internal-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Gateway Architecture - Cadet Docs",
  description: "Ingress boundary — webhooks, Telegram, Twilio, and the reverse proxy.",
  path: "/docs/developer-guide/internals/gateway-architecture",
});

export default function GatewayArchitecturePage() {
  return <InternalDoc slug="gateway-architecture" title="Gateway Architecture" />;
}
