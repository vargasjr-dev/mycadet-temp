/**
 * Account-scoped cache hygiene for a session end. Notification identity
 * memory is invalidated synchronously so in-flight compositor work becomes
 * stale before any await. A Home Screen widget is readable without
 * unlocking the device, so the previous account's conversation titles must
 * not outlive the session that produced them, whichever way it ended. Its
 * clear is a no-op off Capacitor iOS.
 *
 * Awaited, but not gated on: a sign-out the bridge could refuse to complete
 * would be worse than a snapshot that outlives it by one launch. The clears
 * are idempotent, so a superseded observation running them after a session
 * end is harmless.
 */
import { resetNotificationIdentitySession } from "@/runtime/notification-avatar";
import { clearWidgetSnapshot } from "@/runtime/widget-snapshot";

export async function endSession(): Promise<void> {
  resetNotificationIdentitySession();
  await clearWidgetSnapshot();
}
