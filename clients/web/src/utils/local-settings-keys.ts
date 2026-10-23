/**
 * localStorage keys for AI settings.
 *
 * Centralized here so keys are discoverable and consistent. Each card
 * reads/writes via `getLocalSetting` / `setLocalSetting` using these
 * constants as the key argument.
 */

export const LS_IMAGE_GEN_PROVIDER = "cadet:ai:imageGenProvider";
export const LS_IMAGE_GEN_MODEL = "cadet:ai:imageGenModel";
export const LS_WEB_SEARCH_PROVIDER = "cadet:ai:webSearchProvider";
export const LS_WEB_FETCH_PROVIDER = "cadet:ai:webFetchProvider";
export const LS_EMAIL_MODE = "cadet:ai:emailMode";
export const LS_EMAIL_BYO_PROVIDER = "cadet:ai:emailByoProvider";
/**
 * Prefix, completed with the assistant id: a JSON array of message ids the
 * user deleted from that assistant's inbox on this device. The cloud keeps
 * no delete for a single message, so the inbox hides them here instead.
 */
export const LS_ASSISTANT_INBOX_DELETED_EMAILS_PREFIX =
  "cadet:ui:assistantInboxDeletedEmails:";
/**
 * Prefix, completed with the assistant id: a JSON array of message ids the
 * user has opened in that assistant's inbox on this device. The cloud
 * keeps no read state, so the list's unread mark is this device's memory.
 */
export const LS_ASSISTANT_INBOX_READ_EMAILS_PREFIX =
  "cadet:ui:assistantInboxReadEmails:";
/**
 * Prefix, completed with the assistant id: "1" while the user has pinned
 * that assistant's Email to the side menu on this device.
 */
export const LS_ASSISTANT_INBOX_PINNED_PREFIX =
  "cadet:ui:assistantInboxPinned:";
/**
/**
 * Prefix, completed with a feature intro id (`FeatureIntroId` in
 * `hooks/use-feature-intro-seen.ts`): "1" once the one-time intro modal for
 * that feature has been dismissed on this device. Never cleared by the app;
 * an intro is seen once.
 */
export const LS_FEATURE_INTRO_SEEN_PREFIX = "cadet:ui:featureIntroSeen:";

export const LS_TTS_PROVIDER = "cadet:voice:ttsProvider";
export const LS_TTS_API_KEY_PREFIX = "cadet:voice:ttsApiKey:";
export const LS_TTS_VOICE_ID_PREFIX = "cadet:voice:ttsVoiceId:";
export const LS_STT_PROVIDER = "cadet:voice:sttProvider";
export const LS_STT_API_KEY_PREFIX = "cadet:voice:sttApiKey:";
