import type { KeyboardEvent } from "react";

const NEXT_KEYS = new Set(["ArrowDown", "ArrowRight"]);
const PREV_KEYS = new Set(["ArrowUp", "ArrowLeft"]);

/**
 * Arrow-key navigation for the chooser's radiogroup of cards. Port of web's
 * radio-card-nav with one deliberate deviation: arrows move focus and wrap
 * at the ends but never click — the app chooser's select handler navigates
 * into the assistant, so selection-by-arrow would eject the user mid-browse.
 * Enter, Space, and click remain the ways to select.
 *
 * Only events originating on one of the group's radios are handled; arrows
 * pressed elsewhere inside the group keep their default behavior.
 */
export function handleRadioCardArrowNav(e: KeyboardEvent<HTMLElement>): void {
  if (!NEXT_KEYS.has(e.key) && !PREV_KEYS.has(e.key)) {
    return;
  }
  const origin = (e.target as HTMLElement).closest<HTMLElement>(
    '[role="radio"]',
  );
  if (!origin) {
    return;
  }
  const radios = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'),
  );
  const current = radios.indexOf(origin);
  if (current < 0) {
    return;
  }
  const delta = NEXT_KEYS.has(e.key) ? 1 : -1;
  const next = radios[(current + delta + radios.length) % radios.length];
  e.preventDefault();
  next.focus();
}
