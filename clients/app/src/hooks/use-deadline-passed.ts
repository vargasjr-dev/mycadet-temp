import { useEffect, useState } from "react";

/** Disarming clears the deadline so a later pending window gets its full timeout. */
export function useDeadlinePassed(armed: boolean, timeoutMs: number): boolean {
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    if (!armed) {
      setPassed(false);
      return;
    }
    const timer = setTimeout(() => setPassed(true), timeoutMs);
    return () => clearTimeout(timer);
  }, [armed, timeoutMs]);
  return passed;
}
