const repository = "vargasjr-dev/mycadet-temp";
const assets: Record<string, string> = {
  mac: "mycadet.dmg",
  windows: "mycadet-windows-x64.exe",
  linux: "mycadet-linux-x64.AppImage",
};
interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: { name: string; browser_download_url: string }[];
}

function isRelease(value: unknown): value is Release {
  if (!value || typeof value !== "object") {
    return false;
  }
  return (
    "tag_name" in value &&
    typeof value.tag_name === "string" &&
    "draft" in value &&
    typeof value.draft === "boolean" &&
    "prerelease" in value &&
    typeof value.prerelease === "boolean" &&
    "published_at" in value &&
    (value.published_at === null || typeof value.published_at === "string") &&
    "assets" in value &&
    Array.isArray(value.assets) &&
    value.assets.every(
      (asset: unknown) =>
        asset !== null &&
        typeof asset === "object" &&
        "name" in asset &&
        typeof asset.name === "string" &&
        "browser_download_url" in asset &&
        typeof asset.browser_download_url === "string",
    )
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ platform: string }> },
) {
  const { platform } = await context.params;
  const name = assets[platform];
  const channel = new URL(request.url).searchParams.get("channel") ?? "prod";
  if (!name || !["dev", "prod"].includes(channel)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/releases?per_page=100`,
      {
        headers: { Accept: "application/vnd.github+json" },
        next: { revalidate: 300 },
      },
    );
    if (!response.ok) {
      throw new Error("Release lookup failed");
    }
    const data: unknown = await response.json();
    if (!Array.isArray(data)) {
      throw new Error("Invalid releases response");
    }
    const releases = data.filter(isRelease);
    const release = releases
      .filter(
        (r) =>
          !r.draft &&
          /^v\d+\.\d+\.\d+/.test(r.tag_name) &&
          (channel === "dev"
            ? r.prerelease && r.tag_name.includes("-dev.")
            : !r.prerelease) &&
          r.assets.some((a) => a.name === name),
      )
      .sort((a, b) =>
        (b.published_at ?? "").localeCompare(a.published_at ?? ""),
      )[0];
    const url = release?.assets.find(
      (a) => a.name === name,
    )?.browser_download_url;
    if (
      url?.startsWith(`https://github.com/${repository}/releases/download/`)
    ) {
      return new Response(null, {
        status: 307,
        headers: { Location: url, "Cache-Control": "no-store" },
      });
    }
  } catch {
    // Keep an unavailable channel from sending visitors to a broken asset URL.
  }
  return new Response(
    "This installer is not available yet. Please try again later.",
    {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "300" },
    },
  );
}
