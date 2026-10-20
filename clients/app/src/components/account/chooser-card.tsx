import { type KeyboardEvent, type ReactNode } from "react";

interface ChooserCardProps {
  /** The card's leading icon slot (48px), e.g. the row's avatar chip. */
  icon: ReactNode;
  title: string;
  /** Secondary line under the title; omitted until the list carries one. */
  subtitle?: string;
  /** Rendered as the radiogroup's checked card. */
  selected?: boolean;
  /** The radiogroup's single roving tab stop lands on this card. */
  tabStop?: boolean;
  onSelect: () => void;
}

/**
 * One assistant row in the account chooser. Port of web's onboarding
 * ChooserCard scoped to what the app bundle needs today: no locked arm
 * (unauthenticated users are redirected by the account gate; the connect
 * and remove arms arrive with their own PRs), no electron-dense metrics
 * (the app bundle has no electron runtime check), and the subtitle is
 * optional until the list payload threads `created`.
 *
 * The card is a radio in the chooser's radiogroup: Enter, Space, and click
 * select; arrows move focus between cards (see `radio-card-nav`).
 */
export function ChooserCard({
  icon,
  title,
  subtitle,
  selected = false,
  tabStop = false,
  onSelect,
}: ChooserCardProps) {
  const select = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={tabStop ? 0 : -1}
      onClick={onSelect}
      onKeyDown={select}
      className={[
        "group flex w-full cursor-pointer items-center gap-4 rounded-2xl border px-[18px] py-4 text-left",
        "transition-all duration-200 ease-out",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-base)]",
        selected
          ? "border-[var(--primary-base)] bg-[var(--surface-lift)]"
          : "border-[var(--border-base)] bg-[var(--surface-lift)]/60 hover:border-[var(--border-element)] hover:bg-[var(--surface-lift)]",
      ].join(" ")}
    >
      <div
        className={[
          "flex h-12 w-12 shrink-0 items-center justify-center rounded-[10px] transition-colors duration-200",
          selected
            ? "bg-[var(--primary-base)] text-[var(--surface-base)]"
            : "bg-[var(--surface-active)]/40 text-[var(--content-secondary)]",
        ].join(" ")}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <span className="block text-body-medium-default text-[var(--content-default)]">
          {title}
        </span>
        {subtitle && (
          <span className="mt-1 block text-body-small-lighter text-[var(--content-tertiary)]">
            {subtitle}
          </span>
        )}
      </div>
    </div>
  );
}
