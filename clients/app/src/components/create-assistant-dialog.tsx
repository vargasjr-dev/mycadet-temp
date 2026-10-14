import { useState } from "react";

import { createCloudAssistant } from "@app/assistant/create-cloud-assistant";
import { useTranslation } from "@app/i18n";
import { Button } from "@mycadet/design-library/components/button";
import { Input } from "@mycadet/design-library/components/input";
import { Modal } from "@mycadet/design-library/components/modal";
import { toast } from "@mycadet/design-library/components/toast";

interface CreateAssistantDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CreateAssistantDialog({
  open,
  onClose,
}: CreateAssistantDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);

  const handleCreate = async () => {
    setPending(true);
    const result = await createCloudAssistant(name.trim() || undefined);
    setPending(false);
    if (result.ok) {
      toast.success(t("createAssistantDialog.toastSuccess"));
      setName("");
      onClose();
      return;
    }
    toast.error(result.error);
  };

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) {
          onClose();
        }
      }}
    >
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>{t("createAssistantDialog.title")}</Modal.Title>
          <Modal.Description>
            {t("createAssistantDialog.description")}
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("createAssistantDialog.namePlaceholder")}
            autoFocus
            disabled={pending}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !pending) {
                void handleCreate();
              }
            }}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" onClick={onClose} disabled={pending}>
            {t("createAssistantDialog.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleCreate()}
            disabled={pending}
            loading={pending}
          >
            {t("createAssistantDialog.create")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
