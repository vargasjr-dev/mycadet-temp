import { SkillsReferenceChatGPTImportContent } from "@/app/docs/_components/skills-reference-chat-gpt-import-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "ChatGPT Import - Cadet Docs",
  description:
    "ChatGPT Import skill for Cadet — imports your conversation history from ChatGPT into Cadet.",
  path: "/docs/skills-reference/chatgpt-import",
});

export default function SkillsReferenceChatGPTImportPage() {
  return <SkillsReferenceChatGPTImportContent />;
}
