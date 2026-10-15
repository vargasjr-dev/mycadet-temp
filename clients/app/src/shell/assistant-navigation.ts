const ORIGIN = "https://app.example";

function route(value: string): URL {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020]/.test(value)
  ) {
    throw new Error("Invalid assistant path.");
  }
  const decoded = decodeURIComponent(value.split(/[?#]/)[0]);
  if (
    decoded.includes("\\") ||
    decoded.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Invalid assistant path.");
  }
  return new URL(value, ORIGIN);
}

export function assistantMountPath(value: string): string {
  const url = route(value);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname || url.search || url.hash) {
    throw new Error("Invalid assistant mount path.");
  }
  return pathname;
}

function remap(value: string, from: string, to: string): string {
  const url = route(value);
  if (url.pathname !== from && !url.pathname.startsWith(`${from}/`)) {
    throw new Error("Path is outside the assistant mount.");
  }
  return `${to}${url.pathname.slice(from.length) || "/"}${url.search}${url.hash}`;
}

export function framePath(
  location: string,
  mountPath: string,
  entryUrl: string,
  origin: string,
): string {
  const entry = new URL(entryUrl, origin);
  return remap(
    location,
    assistantMountPath(mountPath),
    entry.pathname.replace(/\/+$/, ""),
  );
}

export function hostPath(
  path: string,
  mountPath: string,
  entryUrl: string,
  origin: string,
): string {
  const entry = new URL(entryUrl, origin);
  const pathname = route(path).pathname;
  const from =
    pathname === "/assistant" || pathname.startsWith("/assistant/")
      ? "/assistant"
      : entry.pathname.replace(/\/+$/, "");
  return remap(path, from, assistantMountPath(mountPath));
}

export function frameUrl(
  location: string,
  mountPath: string,
  entryUrl: string,
  origin: string,
): string {
  return new URL(
    framePath(location, mountPath, entryUrl, origin),
    new URL(entryUrl, origin),
  ).href;
}
