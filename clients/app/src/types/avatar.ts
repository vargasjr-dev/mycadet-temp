/**
 * Avatar domain types — the daemon's avatar wire contract, hand-declared so
 * the app bundle carries no generated SDK and no cross-package codegen
 * (the scoped daemon surface is gone from the app; the chat bundle owns the
 * generated client). The runtime guards (`isCharacterTraits`,
 * `isAvatarState`) live here because these are compile-time types only —
 * code that validates an untrusted payload (e.g. a legacy sidecar file or a
 * cross-version daemon response) still needs a runtime narrowing function.
 */

export type AvatarStateResponse = {
  kind: "character" | "image" | "none";
  traits: {
    bodyShape: string;
    eyeStyle: string;
    color: string;
  } | null;
  source: "builder" | "upload" | "ai" | null;
  image: {
    updatedAt: string;
    etag: string;
  } | null;
  accent: {
    hex: string;
    source: "palette" | "derived" | "custom";
  } | null;
};

export type CharacterComponentsResponse = {
  bodyShapes: Array<{
    id: string;
    viewBox: { width: number; height: number };
    faceCenter: { x: number; y: number };
    svgPath: string;
  }>;
  eyeStyles: Array<{
    id: string;
    sourceViewBox: { width: number; height: number };
    eyeCenter: { x: number; y: number };
    paths: Array<{ svgPath: string; color: string }>;
  }>;
  colors: Array<{ id: string; hex: string }>;
  faceCenterOverrides: Array<{
    bodyShape: string;
    eyeStyle: string;
    faceCenter: { x: number; y: number };
  }>;
};

export type BodyShapeDefinition =
  CharacterComponentsResponse["bodyShapes"][number];

export type EyeStyleDefinition =
  CharacterComponentsResponse["eyeStyles"][number];

export type EyePathDefinition = EyeStyleDefinition["paths"][number];

export type ColorDefinition = CharacterComponentsResponse["colors"][number];

export type FaceCenterOverride =
  CharacterComponentsResponse["faceCenterOverrides"][number];

export type CharacterComponents = CharacterComponentsResponse;

export type CharacterTraits = NonNullable<AvatarStateResponse["traits"]>;

/**
 * The accent the daemon resolved for the avatar: a character's palette
 * colour, the colour read out of an uploaded image, or one the user set.
 */
export type AvatarAccent = NonNullable<AvatarStateResponse["accent"]>;

export type AvatarAccentSource = AvatarAccent["source"];

/** A resolved avatar render mode: character traits, a custom image url, or neither. */
export interface AvatarRead {
  traits: CharacterTraits | null;
  imageUrl: string | null;
}

export function isCharacterTraits(value: unknown): value is CharacterTraits {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.bodyShape === "string" &&
    typeof obj.eyeStyle === "string" &&
    typeof obj.color === "string"
  );
}

export type AvatarKind = AvatarStateResponse["kind"];

export type AvatarSource = NonNullable<AvatarStateResponse["source"]>;

export type AvatarImageMeta = NonNullable<AvatarStateResponse["image"]>;

/**
 * Authoritative avatar render manifest served by the daemon's
 * `GET /avatar/state` endpoint. `kind` drives rendering; `source` is
 * metadata.
 */
export type AvatarState = AvatarStateResponse;

function isAvatarKind(value: unknown): value is AvatarKind {
  return value === "character" || value === "image" || value === "none";
}

function isAvatarSource(value: unknown): value is AvatarSource {
  return value === "builder" || value === "upload" || value === "ai";
}

function isAvatarImageMeta(value: unknown): value is AvatarImageMeta {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.updatedAt === "string" && typeof obj.etag === "string";
}

function isAvatarAccentSource(value: unknown): value is AvatarAccentSource {
  return value === "palette" || value === "derived" || value === "custom";
}

function isAvatarAccent(value: unknown): value is AvatarAccent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.hex === "string" && isAvatarAccentSource(obj.source);
}

export function isAvatarState(value: unknown): value is AvatarState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    isAvatarKind(obj.kind) &&
    (obj.traits === null || isCharacterTraits(obj.traits)) &&
    (obj.source === null || isAvatarSource(obj.source)) &&
    (obj.image === null || isAvatarImageMeta(obj.image)) &&
    // Absent on assistants that predate accents; `fetchAvatarState` fills
    // in the null.
    (obj.accent === undefined ||
      obj.accent === null ||
      isAvatarAccent(obj.accent))
  );
}
