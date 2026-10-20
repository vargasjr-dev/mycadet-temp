import { useState } from "react";
import { Button } from "@mycadet/design-library/components/button";
import { Modal } from "@mycadet/design-library/components/modal";
import { Notice } from "@mycadet/design-library/components/notice";
import { Toggle } from "@mycadet/design-library/components/toggle";

import type { ConfigGetResponse } from "@/generated/daemon/types.gen";
import { useTranslation } from "@/i18n";

export interface ChatsSettingsValues {
  newMessageEnabled: NonNullable<
    ConfigGetResponse["notifications"]
  >["newMessageEnabled"];
}

export interface ChatsSettingsChanges {
  notifications?: Pick<ChatsSettingsValues, "newMessageEnabled">;
}

interface ChatsSettingsFormProps {
  values: ChatsSettingsValues;
  saveStatus: "idle" | "pending" | "error";
  onSave: (changes: ChatsSettingsChanges) => void;
  onCancel: () => void;
}

const TOGGLE_CLASSES =
  "flex-row-reverse items-start gap-4 [&>div]:flex-1 [&>div>span]:text-[var(--content-secondary)] [&>button]:mt-1 [&>button]:before:absolute [&>button]:before:-inset-x-2.5 [&>button]:before:-inset-y-3.5";

function changedSettings(
  initial: ChatsSettingsValues,
  draft: ChatsSettingsValues,
): ChatsSettingsChanges {
  return {
    ...(draft.newMessageEnabled !== initial.newMessageEnabled
      ? { notifications: { newMessageEnabled: draft.newMessageEnabled } }
      : {}),
  };
}

export function ChatsSettingsForm({
  values,
  saveStatus,
  onSave,
  onCancel,
}: ChatsSettingsFormProps) {
  const { t } = useTranslation("chat");
  // A remote refresh must not turn untouched fields into writes.
  const [initial] = useState(() => structuredClone(values));
  const [draft, setDraft] = useState(initial);
  const changes = changedSettings(initial, draft);
  const dirty = Object.keys(changes).length > 0;
  const saving = saveStatus === "pending";

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving && dirty) {
          onSave(changes);
        }
      }}
    >
      <Modal.Body className="min-h-0 space-y-5 pb-0" aria-busy={saving}>
        <Toggle
          size="sm"
          label={t("chatsSettingsModal.notifications")}
          helperText={t("chatsSettingsModal.notificationsHelper")}
          checked={draft.newMessageEnabled}
          onChange={(newMessageEnabled) =>
            setDraft({ ...draft, newMessageEnabled })
          }
          disabled={saving}
          className={TOGGLE_CLASSES}
        />
        {saveStatus === "error" ? (
          <Notice tone="error">{t("chatsSettingsModal.saveError")}</Notice>
        ) : null}
      </Modal.Body>
      <span role="status" className="sr-only">
        {saving ? t("chatsSettingsModal.saving") : ""}
      </span>
      <Modal.Footer className="shrink-0">
        <Button
          type="button"
          variant="outlined"
          className="text-[var(--content-default)] disabled:text-[var(--content-disabled)]"
          onClick={onCancel}
          disabled={saving}
        >
          {t("chatsSettingsModal.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          className="[[data-theme=velvet]_&]:enabled:bg-[var(--primary-active)]"
          disabled={!dirty}
          loading={saving}
        >
          {saving
            ? t("chatsSettingsModal.saving")
            : t("chatsSettingsModal.confirm")}
        </Button>
      </Modal.Footer>
    </form>
  );
}
