/** Ask the app shell to open its feedback dialog over this frame. */
export function requestShareFeedback(): void {
  if (window.parent === window) return;
  window.parent.postMessage(
    { source: "mycadet-web-share-feedback" },
    window.location.origin,
  );
}
