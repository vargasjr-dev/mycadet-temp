import LegalMarkdown from "@/app/docs/_components/legal-markdown";
import { createMetadata } from "@/lib/metadata";
import { routes } from "@/lib/routes";

export const metadata = createMetadata({
  title: "Privacy Policy | Cadet",
  description:
    "Cadet's privacy policy explaining how we collect, use, disclose and otherwise process your information.",
  path: routes.docs.legal.privacyPolicy,
});

export default function PrivacyPolicyPage() {
  return (
    <LegalMarkdown
      file="privacy-policy"
      title="Privacy Policy"
      breadcrumb="Docs / Legal / Privacy"
    />
  );
}
