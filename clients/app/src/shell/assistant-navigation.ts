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
  origin: string,
): string {
  // The assistant mounts on the shell's own origin at the mount path — the
  // frame's url space IS the host's url space.
  return remap(
    location,
    assistantMountPath(mountPath),
    new URL(assistantMountPath(mountPath), origin).pathname,
  );
}

export function hostPath(path: string, mountPath: string): string {
  const pathname = route(path).pathname;
  // The bundle announces its paths under its own /assistant root; the shell
  // remaps them onto wherever it mounted the mount path.
  const from =
    pathname === "/assistant" || pathname.startsWith("/assistant/")
      ? "/assistant"
      : assistantMountPath(mountPath);
  return remap(path, from, assistantMountPath(mountPath));
}

export function frameUrl(
  location: string,
  mountPath: string,
  origin: string,
): string {
  return new URL(framePath(location, mountPath, origin), origin).href;
}
