import { Settings } from "lucide-react";

import { Modal } from "@mycadet/design-library";

import { ChannelTrustFloorSection } from "@/domains/channels/components/channel-trust-floor-section";
import { EmailCloudContent } from "@/domains/channels/components/email-cloud-content";
import { useChannelTrustFloors } from "@/domains/channels/hooks/use-channel-trust-floors";
import { useTranslation } from "@/i18n";

export interface EmailSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The cloud assistant id the email routes take. */
  assistantId: string;
  /** The local assistant id the gateway's channel policy routes take. */
  localAssistantId: string;
  assistantName: string;
  emailRootDomain: string;
}

/**
 * The cloud email settings from the Channels page, in a modal the inbox
 * opens from its masthead's gear (so the header wears the same gear): the
 * address with its domain's verification, the way to copy or remove it,
 * the repair notice when the domain is not yet set up with the provider,
 * and the day's usage; then who can message the assistant over email, the
 * trust floor the Channels page draws under the same section. One body
 * serves both doors so the two never disagree.
 */
export function EmailSettingsModal({
  open,
  onOpenChange,
  assistantId,
  localAssistantId,
  assistantName,
  emailRootDomain,
}: EmailSettingsModalProps) {
  const { t } = useTranslation("channels");
  const floors = useChannelTrustFloors(localAssistantId);
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content size="md">
        <Modal.Header icon={Settings}>
          <Modal.Title>{t("emailSettingsModal.title")}</Modal.Title>
          <Modal.Description>
            {t("emailSettingsModal.description")}
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <div className="flex flex-col gap-5">
            <EmailCloudContent
              assistantId={assistantId}
              emailRootDomain={emailRootDomain}
            />
            {floors.onChange ? (
              <div className="border-t border-[var(--border-subtle)] pt-5">
                <ChannelTrustFloorSection
                  assistantDisplayName={assistantName}
                  policy={floors.policies?.email}
                  saving={floors.savingKey === "email"}
                  loading={floors.isLoading}
                  error={floors.isError}
                  onChange={(policy) => floors.onChange?.("email", policy)}
                />
              </div>
            ) : null}
          </div>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
