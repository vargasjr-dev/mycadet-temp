import {
  notifySettingChange,
  setLocalSetting,
} from "@app/utils/local-settings";

export const SELECTED_ASSISTANT_STORAGE_KEY = "cadet:selectedAssistantId";

/** The assistant runtime consumes the same-tab notification even without storage. */
export function writeSelectedAssistantId(id: string): void {
  if (!setLocalSetting(SELECTED_ASSISTANT_STORAGE_KEY, id)) {
    notifySettingChange(SELECTED_ASSISTANT_STORAGE_KEY, id);
  }
}
