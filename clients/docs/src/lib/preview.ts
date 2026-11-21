/**
 * The secret preview gate for the landing's in-progress sections: seven
 * consecutive clicks on the hero title unlock them for this tab (session
 * storage), seven more lock them again. Nothing here touches the server —
 * the flag lives in the browser only, so the gated sections stay out of
 * every visitor's HTML unless they know the knock.
 */

export const PREVIEW_KEY = "cadet-preview";
export const PREVIEW_EVENT = "cadet-preview-change";

export function previewUnlocked(): boolean {
  try {
    return window.sessionStorage.getItem(PREVIEW_KEY) === "1";
  } catch {
    return false;
  }
}

export function setPreviewUnlocked(on: boolean): void {
  try {
    if (on) {
      window.sessionStorage.setItem(PREVIEW_KEY, "1");
    } else {
      window.sessionStorage.removeItem(PREVIEW_KEY);
    }
  } catch {
    // private browsing may refuse storage — the knock just won't
    // survive a reload in that tab
  }
  window.dispatchEvent(new Event(PREVIEW_EVENT));
}
