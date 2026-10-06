import { InternalDoc } from "@/app/docs/_components/internal-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Credential Execution Service - Cadet Docs",
  description: "CES — credential isolation, secure commands, and the RPC boundary.",
  path: "/docs/developer-guide/internals/credential-execution-service",
});

export default function CredentialExecutionServicePage() {
  return <InternalDoc slug="credential-execution-service" title="Credential Execution Service" />;
}
