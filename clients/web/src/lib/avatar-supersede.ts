/**
 * Platform ids whose synced avatar was just outranked by fresher local
 * evidence, stamped with when. The daemon syncs the change to the cloud
 * asynchronously and the cloud's read path can lag behind the write, so
 * any list that lands inside the window may still carry the old URL; it is
 * dropped for that id. After the window the cloud copy is trusted again.
 */
export const AVATAR_SUPERSEDE_WINDOW_MS = 60_000;

const supersededAt = new Map<string, number>();

export function markAvatarSuperseded(cloudAssistantId: string): void {
  supersededAt.set(cloudAssistantId, Date.now());
}

/** Inside the window; an expired mark is dropped on the way out. */
export function isAvatarSuperseded(cloudAssistantId: string): boolean {
  const at = supersededAt.get(cloudAssistantId);
  if (at === undefined) {
    return false;
  }
  if (Date.now() - at < AVATAR_SUPERSEDE_WINDOW_MS) {
    return true;
  }
  supersededAt.delete(cloudAssistantId);
  return false;
}

export function resetAvatarSupersedeForTests(): void {
  supersededAt.clear();
}
