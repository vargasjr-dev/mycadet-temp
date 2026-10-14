import {
  type CheckoutHandoff,
  type SignupCheckoutIntent,
} from "@app/lib/billing/checkout-intent";
import { notifySettingChange } from "@app/utils/local-settings";

export const CHECKOUT_INTENT_STORAGE_KEY = "cadet.pro-checkout-intent";

/** The assistant consent screen receives the value even when session storage fails. */
export const checkoutHandoff: CheckoutHandoff = {
  save(intent: SignupCheckoutIntent) {
    const raw = JSON.stringify({
      ...intent,
      savedAt: Date.now(),
    });
    try {
      sessionStorage.setItem(CHECKOUT_INTENT_STORAGE_KEY, raw);
    } catch {
      // The same-tab notification carries the storage-disabled handoff.
    }
    notifySettingChange(CHECKOUT_INTENT_STORAGE_KEY, raw);
  },
  clear() {
    try {
      sessionStorage.removeItem(CHECKOUT_INTENT_STORAGE_KEY);
    } catch {
      // Clear the runtime's in-memory copy through the notification as well.
    }
    notifySettingChange(CHECKOUT_INTENT_STORAGE_KEY, "");
  },
};
