import { useCallback, type ReactNode } from "react";

/**
 * Right-aligned muted annotation on a provider-picker row: the row answers
 * "whose infrastructure" at the moment of choice (Managed / Custom).
 */
export function PickerMeta({ text }: { text: string }) {
  return (
    <span className="text-body-small-default text-[var(--content-tertiary)]">
      {text}
    </span>
  );
}

/**
 * `Select` option fields describing whether the active assistant can use a
 * provider. Empty for a usable one; a provider it cannot reach keeps its row
 * and carries the reason instead.
 */
export interface ProviderPickerAvailability {
  readonly disabled?: boolean;
  readonly tooltip?: string;
  readonly suffix?: ReactNode;
}

/**
 * Availability fields for one provider row, keyed by its picker value (a
 * provider id or an entry value). Spread into the option after the surface's
 * own `suffix`. Empty for a usable provider; a row the assistant cannot act
 * on carries the reason here ("Add API key" for a provider it cannot reach).
 *
 * The reason is both a visible annotation and a hover tooltip: a disabled
 * Radix option takes no focus, so tooltip-only copy never reaches a keyboard
 * or touch user.
 *
 * @see https://www.radix-ui.com/primitives/docs/components/select#item
 */
export function useProviderPickerAvailability(): (
  pickerValue: string,
) => ProviderPickerAvailability {
  return useCallback(() => ({}), []);
}
