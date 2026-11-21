import { useEffect, useState } from "react";

/**
 * Entrance-animation failsafe: true once the deadline has passed. Consumers
 * fold it into their `initial` prop so a stalled animation driver can never
 * hold entrance content invisible past the deadline.
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
