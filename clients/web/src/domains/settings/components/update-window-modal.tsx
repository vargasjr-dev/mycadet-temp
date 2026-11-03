import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { UpdateWindowPolicy } from "@/domains/settings/components/update-window-policy";
import { useTranslation } from "@/i18n";
import { Modal } from "@mycadet/design-library/components/modal";

export interface UpdateWindowModalProps {
  open: boolean;
  onClose: () => void;
}

/** Update-window policy editor, opened from the Version card. */
export function UpdateWindowModal({ open, onClose }: UpdateWindowModalProps) {
  const { t } = useTranslation("settings");
  const assistantId = useActiveAssistantId();

  return (
    <Modal.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose();
        }
      }}
    >
      <Modal.Content size="md">
        <Modal.Header>
          <Modal.Title>{t("updateWindowModal.title")}</Modal.Title>
          <Modal.Description>
            {t("updateWindowModal.description")}
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <UpdateWindowPolicy assistantId={assistantId} />
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
