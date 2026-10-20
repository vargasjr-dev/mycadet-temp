import { useState } from "react";

interface ChooserAvatarChipProps {
  /** The cloud's synced avatar thumbnail, when the list carries one. */
  avatarUrl?: string | null;
  /** The row's display name; the fallback glyph is its initial. */
  name: string;
  /** Pixel size. */
  size?: number;
}

/**
 * Avatar for an assistant row in the account chooser: the cloud's synced
 * thumbnail when the list carries one, else the name's initial. Port of the
 * web chooser's row avatar, scoped to what the app bundle has: the list
 * payload is the only avatar source here (web layers live daemon reads and
 * caches in front of it), and the row's own label already names the
 * assistant, so the chip is decorative. A thumbnail that fails to load
 * (offline, expired signed URL) demotes to the initial for the chip's
 * lifetime instead of showing a broken image; a refreshed list with a new
 * thumbnail retries it.
 */
export function ChooserAvatarChip({
  avatarUrl,
  name,
  size = 20,
}: ChooserAvatarChipProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = avatarUrl && avatarUrl !== failedUrl ? avatarUrl : null;
  return (
    <span aria-hidden="true">
      {url ? (
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          className="rounded-full object-cover"
          style={{ width: size, height: size, flexShrink: 0 }}
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <span
          className="flex shrink-0 items-center justify-center rounded-full bg-[var(--surface-lift)] text-[color:var(--content-tertiary)]"
          style={{
            width: size,
            height: size,
            fontSize: Math.max(9, Math.round(size * 0.45)),
          }}
        >
          {name.charAt(0).toUpperCase()}
        </span>
      )}
    </span>
  );
}
