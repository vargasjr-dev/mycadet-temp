import { ExternalLink } from "lucide-react";
import type { AnchorHTMLAttributes, ReactNode } from "react";

// Narrow paths, not the package root: this file sits under onboarding and
// auth screens whose tests mock `lucide-react` with only the icons they use,
// and the root barrel would load every component and every icon they import.
import { textLinkVariants, type TextLinkTone } from "./text-link";
import { cn } from "../utils/cn";

export type ExternalAnchorProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "target" | "rel"
> & {
  href: string | undefined;
  /**
   * Optional so a self-closing element can be handed to `<Trans components>`,
   * which clones it and injects the translated text as its children.
   */
  children?: ReactNode;
  /**
   * Set to `false` to drop the trailing external-link glyph: for a link shaped
   * like a button, pill, card or row, and for one that draws its own icon.
   * Defaults to `true`.
   */
  glyph?: boolean;
  /**
   * Wear the design library's `TextLink` look in this tone. Leave it unset for
   * an anchor that is not a text link (a button, pill, card or row), which
   * styles itself through `className`.
   */
  tone?: TextLinkTone;
};

/**
 * True for an `http(s)` destination, the links that leave the app for the web
 * and so earn the external-link glyph. Anything else a markdown link can carry
 * (`mailto:`, `tel:`, an in-app path) stays unadorned.
 */
export function isWebUrl(href: string | undefined): boolean {
  return /^https?:\/\//i.test(href ?? "");
}

/**
 * Trailing glyph marking a link as leaving the app.
 *
 * Sized and aligned to sit inside an ordinary (not inline-flex) anchor so long
 * link text still wraps; the glyph aligns via a small baseline shift instead.
 */
export function ExternalLinkGlyph() {
  return (
    <ExternalLink
      aria-hidden
      className="ml-0.5 inline h-3.5 w-3.5 shrink-0 align-[-0.125em]"
    />
  );
}

/**
 * External-link presentation shared across clients. Clients may supply onClick
 * to route links through their native host; browser behavior works by default.
 */
export function ExternalAnchor({
  href,
  children,
  glyph = true,
  tone,
  className,
  ...rest
}: ExternalAnchorProps) {
  return (
    <a
      {...rest}
      className={
        tone === undefined
          ? className
          : cn(textLinkVariants({ tone }), className)
      }
      data-slot={tone === undefined ? undefined : "text-link"}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      {glyph && isWebUrl(href) ? <ExternalLinkGlyph /> : null}
    </a>
  );
}
