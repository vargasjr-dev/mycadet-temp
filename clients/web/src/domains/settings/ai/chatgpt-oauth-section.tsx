import type { ProviderConnection } from "@/generated/daemon/types.gen";
import { Typography } from "@mycadet/design-library/components/typography";

import { useTranslation } from "@/i18n";

import { ChatgptPasteAuthFlow } from "./chatgpt-paste-auth-flow";

interface ChatgptOAuthSectionProps {
  assistantId: string;
  onConnected: (connection: ProviderConnection) => void;
}

/**
 * Connects a ChatGPT subscription. Rendered inside the provider editor when
 * the auth type is `oauth_subscription`.
 *
 * The redirect-and-paste flow is the whole section: it opens a popup to
 * authorize, then hands the daemon the callback URL the user pastes back.
 */
export function ChatgptOAuthSection({
  assistantId,
  onConnected,
}: ChatgptOAuthSectionProps) {
  const { t } = useTranslation("settings");

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border-base)] p-4">
      <Typography
        variant="body-small-default"
        as="p"
        className="text-[var(--content-tertiary)]"
      >
        {t("chatgptOauthSection.intro")}
      </Typography>

      <ChatgptPasteAuthFlow
        assistantId={assistantId}
        onConnected={onConnected}
      />
    </div>
  );
}
