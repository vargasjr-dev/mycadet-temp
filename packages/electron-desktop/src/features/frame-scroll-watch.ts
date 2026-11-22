type SendScrollWatch = (enable: boolean) => void;

let send: SendScrollWatch | null = null;
let onEnded: (() => void) | null = null;

/**
 * Start waiting for the current scroll to end. One waiter at a time: a
 * second call replaces the first's listener, and asks the helper again
 * only if nothing was being watched.
 */
export const watchFrameScroll = (listener: () => void): void => {
  const wasWatching = onEnded !== null;
  onEnded = listener;
  if (!wasWatching) {
    send?.(true);
  }
};

/** Stop waiting, and take the helper's watch down with it. */
export const unwatchFrameScroll = (): void => {
  if (onEnded === null) {
    return;
  }
  onEnded = null;
  send?.(false);
};

/** Whether a waiter is up, so a helper that restarts is put back to watching. */
export const isFrameScrollWatched = (): boolean => onEnded !== null;

/**
 * Register the way to ask the helper. A waiter that arrived first gets its
 * watch sent now.
 */
export const provideFrameScrollWatch = (next: SendScrollWatch): void => {
  send = next;
  if (onEnded !== null) {
    next(true);
  }
};

/** The helper saw the scroll stop. */
export const frameScrollEnded = (): void => {
  onEnded?.();
};

export const __resetFrameScrollWatchForTesting = (): void => {
  send = null;
  onEnded = null;
};
