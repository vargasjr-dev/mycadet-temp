/**
 * The permission surfaces' presentation registry: shells with notification
 * addon flows or settings hand-offs re-prepare the renderer's permission
 * presentation by calling `preparePermissionPresentation`; listeners (the
 * companion surface's permission rows) react.
 *
 * Its own module so the strategy, the service, and the guide's values can
 * all reach it without leaning on each other.
 */
const presentationListeners = new Set<() => void>();

export const onPermissionPresentation = (
  listener: () => void,
): (() => void) => {
  presentationListeners.add(listener);
  return () => {
    presentationListeners.delete(listener);
  };
};

export const preparePermissionPresentation = (): void => {
  for (const listener of presentationListeners) {
    listener();
  }
};
