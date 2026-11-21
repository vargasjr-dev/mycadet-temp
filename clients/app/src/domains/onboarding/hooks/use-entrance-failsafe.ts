import { useEffect, useState } from "react";

/**
 * Entrance-animation failsafe: returns true once the deadline has passed.
 *
 * The onboarding entrances are framer-motion elements held at `opacity: 0`
 * until a delayed animate runs. If the animation driver stalls — a throttled
 * tab, a slow chunk load starving the frame loop — those elements sit
 * invisible while staying in the accessibility tree, which reads to the
 * customer as a broken white screen. Consumers fold the return value into
 * their `initial` prop: once it flips, the entrance is dropped and every
 * element renders at its final values. A screen without its entrance beats a
 * screen without its content.
 */
/**
 * Entrance-animation failsafe: returns true once the deadline has passed.
 *
 * The onboarding entrances are framer-motion elements held at `opacity: 0`
 * until a delayed animate runs. If the animation driver stalls — a throttled
 * tab, a slow chunk load starving the frame loop — those elements sit
 * invisible while staying in the accessibility tree, which reads to the
 * customer as a broken white screen. Consumers fold the return value into
 * their `initial` prop: once it flips, the entrance is dropped and every
 * element renders at its final values. A screen without its entrance beats a
 * screen without its content.
 */
export function useEntranceFailsafe(
  deadlineMs: number = ENTRANCE_DEADLINE_MS,
): boolean {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), deadlineMs);
    return () => clearTimeout(timer);
  }, [deadlineMs]);
  return expired;
}

/** The failsafe deadline, in milliseconds. */
export const ENTRANCE_DEADLINE_MS = 3000;
