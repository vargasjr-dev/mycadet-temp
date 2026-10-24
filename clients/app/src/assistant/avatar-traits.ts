import { z } from "zod";

import { getCloud, postCloud, type CloudResult } from "@app/lib/cloud/request";
import { resolveOrganization } from "@app/lib/cloud/organization";
import { captureError } from "@mycadet/design-library/utils/capture-error";
import { isCharacterTraits, type CharacterTraits } from "@web/types/avatar";

/**
 * The app twin of web's `assistant/avatar-api` character-traits reads and
 * writes, narrowed to what onboarding avatar seeding needs. Both calls ride
 * the gateway-proxied scoped `/v1/assistants/{assistant_id}/...` namespace:
 * the serving host (the Electron `app://` protocol handler, the cloud's
 * runtime proxy) resolves the id to the assistant's gateway, so the renderer
 * never encodes a host or port. Character traits are a plain JSON sidecar in
 * the assistant's workspace, written back through the daemon's
 * render-from-traits route (which also re-renders the avatar PNG). The traits
 * type and guard stay web-canonical (`@web/types/avatar`) — the same source
 * the hatching screen composes its random traits from.
 */

const WorkspaceFileSchema = z.object({ content: z.string() });

/** The workspace sidecar holding the seeded traits. */
const TRAITS_SIDECAR_PATH = "data/avatar/character-traits.json";

/**
 * The assistant's persisted character traits, or `null` when none are stored
 * (the seeding case) or the read failed (seeding stays best-effort — a failed
 * read must never block onboarding, and must never overwrite a traits sidecar
 * it could not understand).
 */
export async function fetchCharacterTraits(
  assistantId: string,
): Promise<CharacterTraits | null> {
  const organization = await resolveOrganization();
  if (!organization.ok) {
    return null;
  }
  const result = await getCloud(
    `/v1/assistants/${encodeURIComponent(assistantId)}/workspace/file?path=${encodeURIComponent(
      TRAITS_SIDECAR_PATH,
    )}`,
    WorkspaceFileSchema,
    { organizationId: organization.data },
  );
  if (!result.ok) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(result.data.content);
    return isCharacterTraits(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persist character traits and re-render the assistant's avatar from them.
 * Resolves whether the write landed; failures are the caller's to tolerate
 * (seeding treats them as "skip the stopgap", never as a flow error).
 */
export async function saveCharacterTraits(
  assistantId: string,
  traits: CharacterTraits,
): Promise<CloudResult<{ ok: boolean }>> {
  const organization = await resolveOrganization();
  if (!organization.ok) {
    return organization;
  }
  return postCloud(
    `/v1/assistants/${encodeURIComponent(assistantId)}/avatar/render-from-traits`,
    z.object({ ok: z.boolean() }),
    traits,
    { organizationId: organization.data },
  );
}

/**
 * Persist the random hatch avatar (skipping the save when one already exists).
 * Fire-and-forget by contract: callers do NOT await it, so onboarding never
 * blocks on the server-side render. Only call this for a freshly hatched
 * assistant, never for an already-active one: a returning user may have an
 * uploaded/AI image avatar, which deletes the character-traits sidecar, so a
 * "no traits" read would wrongly seed random traits over their image.
 */
export async function seedHatchAvatar(
  assistantId: string,
  traits: CharacterTraits,
): Promise<void> {
  try {
    const existing = await fetchCharacterTraits(assistantId);
    if (existing) {
      return;
    }
    await saveCharacterTraits(assistantId, traits);
  } catch (err) {
    captureError(err, { context: "onboarding_avatar_sync" });
  }
}
