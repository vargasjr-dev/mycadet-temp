/**
 * Assistant connection — the interactive "switch to that assistant"
 * operation, shared by notification taps and runtime upgrades.
 *
 * Priming the target's gateway transport and selecting the assistant live
 * here, one layer out from the session lifecycle itself: connecting is an
 * assistant operation. The selection write IS the session commit — the auth
 * store carries no session state to stamp.
 *
 * Unlike the boot-time `establishGatewayConnection`, which swallows
 * failures, these rethrow so the caller can surface the reason — including
 * the typed `GuardianTokenError` from the host seam — and offer recovery
 * instead of dead-ending.
 */
import { getSession } from "@/lib/auth/allauth-client";
import { setSelectedAssistant } from "@/assistant/selection";
import {
  getLocalAssistants,
  getLockfileAssistant,
  primeLocalGatewayConnection,
  primeLocalGatewayConnectionWithRepair,
} from "@/lib/local-mode";
import { isRemoteGatewayEntry } from "@mycadet/local-mode/contract";
import { bootstrapLocalAssistantCloudIdentity } from "@/lib/local-cloud-identity";

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
  await setSelectedAssistant(assistantId);
  bootstrapLocalAssistantCloudIdentity(assistantId);
}

/**
 * Connect to a paired assistant: a remote machine's assistant imported via
 * `cadet connect import`. Primes the host-authorized proxy connection,
 * selects the assistant, and marks the session logged in, mirroring
 * {@link connectLocalAssistant}. It uses the plain gateway prime because
 * `wake` cannot start or repair an assistant on a remote machine. The
 * follow-up cloud probe bootstraps identity only for a local assistant,
 * leaving paired entries as client-side pairing records.
 */
export async function connectPairedAssistant(
  assistantId: string,
): Promise<void> {
  const target = getLockfileAssistant(assistantId);
  if (!target || !isRemoteGatewayEntry(target)) {
    throw new Error("Not a paired assistant");
  }
  await primeLocalGatewayConnection(target);
  await setSelectedAssistant(assistantId);
}

export async function connectCloudAssistant(
  assistantId: string,
): Promise<void> {
  const result = await getSession();
  if (!result.ok || !result.data.user) {
    throw new Error("Platform authentication required");
  }
  await setSelectedAssistant(assistantId);
}
