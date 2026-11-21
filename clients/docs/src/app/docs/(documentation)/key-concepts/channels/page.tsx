import { MarkdownDoc } from "@/app/docs/_components/markdown-doc";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Channels | Cadet Docs",
  description:
    "Cadet communication channels — desktop app, CLI, Telegram, Slack, email, and phone. Same assistant everywhere, adapted to each channel.",
  path: "/docs/key-concepts/channels",
});

export default function ChannelsPage() {
  return (
    <MarkdownDoc
      file="key-concepts/channels"
      title="Channels"
      breadcrumb="Docs / Key Concepts / Channels"
    />
  );
}
