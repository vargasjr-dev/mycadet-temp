import { InternalDoc } from "@/app/docs/_components/internal-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Security Architecture - Cadet Docs",
  description: "Security model — sandboxing, credentials, permissions, and secret handling.",
  path: "/docs/developer-guide/internals/security",
});

export default function SecurityPage() {
  return <InternalDoc slug="security" title="Security Architecture" />;
}
