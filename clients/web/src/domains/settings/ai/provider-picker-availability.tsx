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
