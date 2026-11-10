/**
 * Host navigation requested from the app's own chrome — surfaces that
 * leave the current route for another host route. Today that is the
 * Doctor page's deep link into the assistant's settings: the frame route
 * (`/assistant/*`) hosts the web bundle, so the account page steers the
 * host router, exactly what the frame's host-navigation message does for
 * the other direction.
 */

/** Ask the host router to open a host route. */
export function requestHostNavigation(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
