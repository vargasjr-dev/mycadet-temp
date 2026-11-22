/**
 * Build a stand-in `Conversation` for tests that exercise functions taking the
 * live conversation (surface helpers, the tool executor, post-execution
 * hooks).
 *
 * Those functions read a handful of fields off a `Conversation` that has ~150
 * members, so a test double supplies only what the function under test
 * touches. The double's own members are grafted onto the real class
 * prototype, so the class itself fills in the rest: member reads the double
 * does not override dispatch to the real methods and the value is an
 * `instanceof Conversation`. `Partial<Conversation>` keeps the supplied
 * literal contextually typed — field types and callback parameter types are
 * still checked against the real class, and a renamed or retyped member still
 * breaks the build.
 */

import { Conversation } from "../../daemon/conversation.js";
import type { ChannelCapabilities } from "../../daemon/conversation-assembly-types.js";
import { ConversationModeSessionCoordinator } from "../../daemon/conversation-mode-session.js";
import { MessageQueue } from "../../daemon/conversation-queue-manager.js";

/**
 * Build a coordinator double representing a turn with no mode owner, with
 * `overrides` (checked against the real coordinator) replacing the inert
 * defaults where a test drives a specific owner or disposition.
 */
export function mockUnownedModeSessions(
  overrides: Partial<Conversation["modeSessions"]> = {},
): Conversation["modeSessions"] {
  const sessions: Conversation["modeSessions"] = Object.assign(
    Object.create(ConversationModeSessionCoordinator.prototype),
    {
      acceptTurn: () => undefined,
      getTurnOwner: () => undefined,
      getTerminalDisposition: () => undefined,
      hasResidentWork: () => false,
      keepsSessionOpenAfterTurn: () => false,
      trackPersistedRow: () => false,
      recordStructuralWait: () => false,
      invalidateStructuralWait: () => false,
      settleStructuralWait: () => false,
      invalidateAllStructuralWaits: () => 0,
      beginDraining: () => false,
      finalizeTurn: () => false,
      releaseTurn: () => {},
      transferTurn: () => undefined,
    },
  );
  return applyOverrides(sessions, overrides);
}

/**
 * `TExtra` carries test-only fields a double hangs off the same object
 * (recorded calls, captured messages) through to the return type, so a caller
 * can still read `ctx.processMessageCalls` off the result.
 */
export function asConversation<TExtra extends object = object>(
  mock: Partial<Conversation> & TExtra,
): Conversation & TExtra {
  // Trust accessors, derived from the double's own fields exactly as the real
  // class derives them, so a double that sets (or later mutates) the fields
  // resolves the same values production would. Supplied only when the double
  // does not bring its own, and reading through `conversation` rather than
  // `mock` so a test that reassigns the fields on the returned object is
  // honoured.
  const conversation: Conversation & TExtra = Object.create(
    Conversation.prototype,
  );
  // A class-instance double keeps its own behavior: its prototype's methods
  // come along as own properties (the spread below only carries own props).
  const mockProto = Object.getPrototypeOf(mock);
  if (mockProto && mockProto !== Object.prototype) {
    for (const [name, desc] of Object.entries(
      Object.getOwnPropertyDescriptors(mockProto),
    )) {
      if (name !== "constructor") {
        Object.defineProperty(conversation, name, desc);
      }
    }
  }
  applyOverrides(conversation, {
    getTurnTrust: () => conversation.currentTurnTrustContext,
    getTrustContext: () => conversation.trustContext,
    getTurnOrRestingTrust: () =>
      conversation.currentTurnTrustContext ?? conversation.trustContext,
    isStale: () => false,
    hasInFlightWork: () => false,
    modeSessions: mockUnownedModeSessions(),
    // The prototype inheritance below carries the real class's
    // `hasNoClient` getter (`currentTurnIsNonInteractive ?? true`), which
    // on a bare double resolves TRUE and silently flips every
    // interactivity-gated path (ui_show's awaitAction, wake delivery).
    // A double is an in-turn, human-present conversation unless it opts
    // out — matching the falsy `hasNoClient` these doubles had before the
    // prototype-based rebuild.
    currentTurnIsNonInteractive: false,
    ...mock,
  });
  return conversation;
}

/**
 * Build a queue double with `overrides` (checked against the real queue)
 * replacing the inert defaults.
 */
export function mockMessageQueue(
  overrides: Partial<Conversation["queue"]> = {},
): Conversation["queue"] {
  const queue: Conversation["queue"] = Object.create(MessageQueue.prototype);
  return applyOverrides(queue, overrides);
}

/**
 * Write the overrides on as own data properties. `defineProperty`, not
 * assignment, because a double may override a getter-only accessor (the real
 * queue's `length`), which a strict-mode assignment would throw on.
 */
function applyOverrides<T extends object>(target: T, overrides: object): T {
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return target;
}

/**
 * Fill a partial capability set out to a full `ChannelCapabilities`.
 *
 * Surface tests care about `channel` and `supportsDynamicUi`; the remaining
 * required fields are noise at the call site but must be present for the
 * value to be a real `ChannelCapabilities`. Defaults are the conservative
 * ones (no dashboard, no voice), so a test that forgets to opt in gets the
 * restrictive branch rather than a silently permissive one.
 */
export function mockChannelCapabilities(
  caps: Pick<ChannelCapabilities, "channel" | "supportsDynamicUi"> &
    Partial<ChannelCapabilities>,
): ChannelCapabilities {
  return { dashboardCapable: false, supportsVoiceInput: false, ...caps };
}
