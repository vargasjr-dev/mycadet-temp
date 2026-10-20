import {
  getLocalSetting,
  notifySettingChange,
  removeLocalSetting,
  setLocalSetting,
} from "@app/utils/local-settings";

export const SELECTED_ASSISTANT_STORAGE_KEY = "cadet:selectedAssistantId";

/** The assistant runtime consumes the same-tab notification even without storage. */
export function writeSelectedAssistantId(id: string): void {
  if (!setLocalSetting(SELECTED_ASSISTANT_STORAGE_KEY, id)) {
    notifySettingChange(SELECTED_ASSISTANT_STORAGE_KEY, id);
  }
}

/** The stored selection, or undefined when nothing is stored. */
export function readSelectedAssistantId(): string | undefined {
  const value = getLocalSetting(SELECTED_ASSISTANT_STORAGE_KEY, "");
  return value === "" ? undefined : value;
}

/** Drop the stored selection and tell the runtime the slot emptied. */
export function clearSelectedAssistantId(): void {
  removeLocalSetting(SELECTED_ASSISTANT_STORAGE_KEY);
  notifySettingChange(SELECTED_ASSISTANT_STORAGE_KEY, "");
}
