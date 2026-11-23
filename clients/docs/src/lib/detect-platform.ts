export type DownloadsCardId =
  | "iphone"
  | "android"
  | "mac"
  | "chrome"
  | "windows"
  | "terminal"
  | "linux";

type DetectedOS = "ios" | "android" | "mac" | "windows" | "linux" | "other";
type DetectedBrowser = "chrome" | "safari" | "firefox" | "edge" | "other";

const CANONICAL_ORDER: DownloadsCardId[] = [
  "iphone",
  "android",
  "mac",
  "windows",
  "linux",
  "terminal",
  "chrome",
];

export function detectOS(ua: string): DetectedOS {
  const u = ua.toLowerCase();
  if (/iphone|ipod|ipad/.test(u)) {
    return "ios";
  }
  if (/android/.test(u)) {
    return "android";
  }
  if (/cros/.test(u)) {
    return "linux";
  }
  if (/mac os x|macintosh/.test(u)) {
    return "mac";
  }
  if (/windows/.test(u)) {
    return "windows";
  }
  if (/linux|x11/.test(u)) {
    return "linux";
  }
  return "other";
}

export function detectBrowser(ua: string): DetectedBrowser {
  const u = ua.toLowerCase();
  if (/edg\//.test(u)) {
    return "edge";
  }
  if (/firefox|fxios/.test(u)) {
    return "firefox";
  }
  if (/chrome|crios/.test(u)) {
    return "chrome";
  }
  if (/safari/.test(u)) {
    return "safari";
  }
  return "other";
}

function score(id: DownloadsCardId, os: DetectedOS): number {
  const osMatch =
    (id === "iphone" && os === "ios") ||
    (id === "android" && os === "android") ||
    (id === "mac" && os === "mac") ||
    (id === "windows" && os === "windows") ||
    (id === "linux" && os === "linux");
  if (osMatch) {
    return 3;
  }
  if (id === "chrome") {
    return -1;
  }
  if (
    id === "terminal" &&
    (os === "mac" || os === "windows" || os === "linux")
  ) {
    return 1;
  }
  return 0;
}

export function downloadsCardOrder(ua: string | null): DownloadsCardId[] {
  const os = ua ? detectOS(ua) : "other";
  return [...CANONICAL_ORDER].sort((a, b) => score(b, os) - score(a, os));
}
