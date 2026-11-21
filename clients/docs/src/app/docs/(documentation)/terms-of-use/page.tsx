import LegalMarkdown from "@/app/docs/_components/legal-markdown";
import { createMetadata } from "@/lib/metadata";
import { routes } from "@/lib/routes";

export const metadata = createMetadata({
  title: "Terms of Service | Cadet",
  description:
    "Cadet's terms of service — the agreement governing your use of the assistant cloud and services.",
  path: routes.docs.legal.termsOfUse,
});

export default function TermsOfUsePage() {
  return (
    <LegalMarkdown
      file="terms-of-use"
      title="Cadet Terms of Service"
      breadcrumb="Docs / Legal / Terms"
    />
  );
}
