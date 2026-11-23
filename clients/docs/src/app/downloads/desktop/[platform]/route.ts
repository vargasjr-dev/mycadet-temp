import { z } from "zod";

const repository = "vargasjr-dev/mycadet-temp";
const assets: Record<string, string> = {
  mac: "mycadet.dmg",
  windows: "mycadet-windows-x64.exe",
  linux: "mycadet-linux-x64.AppImage",
};
const releasesSchema = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    published_at: z.string().nullable(),
    assets: z.array(
      z.object({
        name: z.string(),
        browser_download_url: z.string().url(),
      }),
    ),
  }),
);

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
    const releases = releasesSchema.parse(await response.json());
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
