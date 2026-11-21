/**
 * Minimal structural slice of hast — enough to walk a rendered list node
 * without pinning a `@types/hast` version.
 */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export interface NavCard {
  href: string;
  title: string;
  desc: string;
}

function textContent(node: HastNode): string {
  if (node.type === "text") {return node.value ?? "";}
  if (node.type !== "element") {return "";}
  return (node.children ?? []).map(textContent).join("");
}

/**
 * Detects the homepage's jumping-off list: every item is a single link
 * followed by an em-dash description. Returns the card data, or null when
 * the list doesn't have that shape (the caller then renders a normal list).
 *
 * The markdown source stays plain markdown:
 *
 *   - [Getting Started](/docs/getting-started) — Install, set up, and go.
 */
export function navCardsFromList(node: HastNode): NavCard[] | null {
  if (node.tagName !== "ul") {return null;}

  const items = (node.children ?? []).filter(
    (child): child is HastNode =>
      child.type === "element" && child.tagName === "li",
  );
  if (items.length === 0) {return null;}
  // Anything that isn't a list item or inter-item whitespace breaks the shape.
  if (
    (node.children ?? []).some(
      (child) => child.type === "element" && child.tagName !== "li",
    )
  ) {
    return null;
  }

  const cards: NavCard[] = [];
  for (const li of items) {
    const first = (li.children ?? [])[0];
    if (!first || first.type !== "element" || first.tagName !== "a") {
      return null;
    }
    const href = (first.properties?.href as string | undefined) ?? "";
    if (!href) {return null;}

    const rest = (li.children ?? [])
      .slice(1)
      .map(textContent)
      .join("")
      .replace(/^[\s—-]+/, "")
      .trim();
    if (!rest) {return null;}

    cards.push({ href, title: textContent(first).trim(), desc: rest });
  }
  return cards;
}
