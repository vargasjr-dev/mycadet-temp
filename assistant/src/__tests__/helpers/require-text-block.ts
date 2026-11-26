import type { ContentBlock, TextContent } from "../../providers/types.js";

export function requireTextBlock(block: ContentBlock | undefined): TextContent {
  if (block?.type !== "text") {
    throw new Error(`Expected a text block, got ${block?.type ?? "no block"}`);
  }
  return block;
}
