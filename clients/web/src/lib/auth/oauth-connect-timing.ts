/**
 * Timing policy for the cloud OAuth connect flow.
 *
 * Separated so tests can shrink the waits without holding a suite open for
 * real seconds, and so the two numbers that shape how long a user looks at a
 * spinner sit together rather than buried in the hook.
 */

/** Backstop poll while an authorization is open. */
export const CONNECTION_POLL_INTERVAL_MS = 3000;

/**
 * How long that poll runs. An attempt the user walked away from would
 * otherwise poll for the life of the tab. A refetch on window focus stays
 * armed past this, which is the signal that actually matters.
 */
export const CONNECTION_POLL_WINDOW_MS = 5 * 60_000;
