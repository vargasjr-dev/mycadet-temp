/**
 * Assistant connection — the interactive "switch to that assistant"
 * operation, shared by notification taps and runtime upgrades.
 *
 * Priming the target's gateway transport, selecting the assistant, and
 * committing the session the connect establishes live here, one layer out
 * from the session lifecycle itself: connecting is an assistant operation.
 * The session writes go through the auth store's commit seams until session
 * state re-homes to the app bundle.
 *
 * Unlike `initSession`, which is the best-effort boot probe and swallows
 * failures, these rethrow so the caller can surface the reason — including
 * the typed `GuardianTokenError` from the host seam — and offer recovery
 * instead of dead-ending.
 */
import { getSession } from "@/lib/auth/allauth-client";
import { bootstrapLocalAssistantCloudIdentity } from "@/lib/local-cloud-identity";
import {
  getLocalAssistants,
  getLockfileAssistant,
  isRemoteGatewayEntry,
  primeLocalGatewayConnection,
  primeLocalGatewayConnectionWithRepair,
} from "@/lib/local-mode";
import {
  commitCloudSession,
  commitLocalSession,
  probeCloudSessionForConnect,
  toAuthUser,
  useAuthStore,
} from "@/stores/auth-store";
import { isConfirmedCloudSession } from "@/stores/session-status";
import { useOrganizationStore } from "@/stores/organization-store";

/**
 * Connect to a specific local assistant. Primes its gateway connection,
 * selects the assistant, and marks the session logged in.
 *
 * Priming runs BEFORE the selection write: the lifecycle's selection
 * subscription republishes the connection synchronously on the write, so
 * the token must already be minted for the new gateway — and a failed
 * connect leaves the previous selection in place.
 *
 * Primes through `primeLocalGatewayConnectionWithRepair`, which rides out a
 * starting gateway and self-heals a stopped or mis-seeded assistant via
 * `wake` before surfacing any error, matching the native client's
 * re-pair-on-connect bootstrap. The boot probe deliberately stays on the
 * startup-retry primitive so app launch never spawns assistant processes.
 */
export async function connectLocalAssistant(
  assistantId: string,
): Promise<void> {
  const target = getLocalAssistants().find(
    (a) => a.assistantId === assistantId,
  );
  await primeLocalGatewayConnectionWithRepair(target);
  await commitLocalSession(assistantId);
  const { cloudSession, cloudSessionRestoredOffline } = useAuthStore.getState();
  if (isConfirmedCloudSession(cloudSession, cloudSessionRestoredOffline)) {
    bootstrapLocalAssistantCloudIdentity(assistantId);
  }
  probeCloudSessionForConnect();
}

/**
 * Connect to a paired assistant: a remote machine's assistant imported via
 * `cadet connect import`. Primes the host-authorized proxy connection,
 * selects the assistant, and marks the session logged in, mirroring
 * {@link connectLocalAssistant} with two deliberate differences: it primes
 * through the plain `primeLocalGatewayConnection` because `wake` cannot
 * start or repair an assistant on a remote machine, and it skips
 * `bootstrapLocalAssistantCloudIdentity` because that registers a LOCAL
 * assistant with the cloud while a paired entry is only a client-side
 * pairing record.
 */
export async function connectPairedAssistant(
  assistantId: string,
): Promise<void> {
  const target = getLockfileAssistant(assistantId);
  if (!target || !isRemoteGatewayEntry(target)) {
    throw new Error("Not a paired assistant");
  }
  await primeLocalGatewayConnection(target);
  await commitLocalSession(assistantId);
  probeCloudSessionForConnect();
}

export async function connectCloudAssistant(
  assistantId: string,
): Promise<void> {
  const result = await getSession();
  if (!result.ok || !result.data.user) {
    throw new Error("Platform authentication required");
  }
  const user = toAuthUser(result.data.user);
  // Hydrate the organizations to avoid race conditions from lazy fetch; a
  // settled rejection fails the connect before the assistant selection and
  // user-scoped sync below, so a caller that catches the error keeps its
  // current selection and consent state rather than the rejected
  // account's.
  const orgOutcome = await useOrganizationStore.getState().fetchOrganizations();
  if (!orgOutcome.ok && orgOutcome.kind === "rejected") {
    throw new Error("Platform authentication required");
  }
  await commitCloudSession(user, assistantId);
}
