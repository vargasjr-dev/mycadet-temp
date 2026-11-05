/**
 * Minimal positioned-node shape the viewport + fit math depend on. `TreeNode`
 * (skills constellation) and the concept-graph's force-laid-out nodes both
 * satisfy it, so `useConstellationViewport` and {@link computeFit} are reused
 * across both graphs without coupling to either's node model.
 */
export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  radius: number;
}
