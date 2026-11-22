import {
  COMPANION_BASE_CAPTURE_PICKER_WIDTH,
  COMPANION_BASE_MAX_PILL_WIDTH,
  companionBoxFor,
  companionCardSideFor,
  companionDockIsSide,
  companionGapFor,
  companionLowerReachFor,
  companionNearEdgeFor,
  companionPadFor,
  companionScaleFor,
  type CompanionCardGrowth,
  type CompanionDock,
  type CompanionGrowth,
  type CompanionSize,
} from "@mycadet/ipc-contract";

/**
 * Everything the window's placement depends on, for one pair of companion
 * sizes.
 *
 * A record rather than a set of module constants because the user picks the
 * sizes and the whole canvas follows them. Passed to the placement
 * rules explicitly rather than read off the module, so they stay pure functions
 * of their inputs and every size is a case a test can state.
 */
export interface CompanionGeometry {
  /** The creature's box, which is the whole of its own scale. */
  avatarBox: number;
  /**
   * The pill's box, which is the scale of everything that is not the creature.
   */
  optionsBox: number;
  /** The canvas, sized to hold the largest state in either direction. */
  canvasWidth: number;
  canvasHeight: number;
  /** How much canvas the card's side of the avatar needs, shadow included. */
  riseAbove: number;
  /**
   * How much the other side needs: the avatar, whatever of the pill reaches
   * back past it, and the shadow.
   */
  dropBelow: number;
  /**
   * The pill's far edge at its widest, measured from the avatar's centre.
   *
   * Whole points, as every number here is: the window is placed and sized in
   * them, and the avatar stands on the line between the two offsets and on the
   * canvas's own centre line.
   */
  maxReach: number;
}

/**
 * The canvas for a pair of named sizes.
 *
 * Each name goes through its own axis's table ({@link companionBoxFor}), so the
 * same name on both axes is a creature and a pill a notch apart rather than two
 * boxes of one size.
 *
 * The asymmetry between {@link CompanionGeometry.riseAbove} and `dropBelow` is
 * the point of the shape. Sizing both sides for the card, which is what pinning
 * the avatar to the canvas's centre amounts to, spends the card's whole height
 * on a side that never draws anything taller than the pill, and macOS
 * refuses a window origin above the top of the work area, so that spend is
 * exactly how far short of the top the avatar would stop.
 *
 * The canvas is sized for the tallest state rather than resized on the phase,
 * the same bargain the width makes. A canvas that grew with the card would move
 * the window under the pointer mid-press and put the expansion back on the main
 * process, which is what the fixed canvas exists to avoid. It *is* resized when
 * the user picks a different size on either axis, which is a deliberate,
 * one-off event rather than something that happens mid-gesture.
 *
 * A call docked to a side of the display is the other such event. The bar
 * stands up as a column centred on the avatar, and a column reaches as far
 * below the avatar as above it, where the canvas above keeps only the near
 * edge below. So for a side dock the canvas is symmetric about the avatar
 * instead: as tall each way as the column's half length, the gap, the creature
 * standing at the column's end and the pad. Taller below than the ordinary
 * canvas, which the window server allows (the canvas may hang off the bottom
 * of a display), and shorter above, which is what keeps the avatar reachable
 * near the top on a display shorter than the ordinary canvas is wide.
 */
export const geometryFor = (
  avatar: CompanionSize,
  options: CompanionSize,
  dock: CompanionDock = "bottom",
  attachedRise = 0,
): CompanionGeometry => {
  const avatarBox = companionBoxFor("avatar", avatar);
  const optionsBox = companionBoxFor("options", options);
  const pad = companionPadFor(avatarBox, optionsBox);
  const gap = companionGapFor(avatarBox, optionsBox);
  const maxPillWidth =
    COMPANION_BASE_MAX_PILL_WIDTH * companionScaleFor(optionsBox);
  // The avatar holds its place and the pill hangs off one side of it across the
  // gap, so the reach is the avatar's half box, the gap, and the widest pill.
  // The canvas has to hold it in whichever direction main later picks, so it is
  // sized for both sides, and `growthFor` picks that direction by the same
  // number. Whole points like everything else published here: the options
  // sizes below the authored box are not whole multiples of it, and a reach
  // carrying a repeating fraction is a canvas edge that lands between points.
  const maxReach = Math.round(avatarBox / 2 + gap + maxPillWidth);
  // Both distances come from the contract, which is where the renderer reads
  // them too: main places the window by them and the renderer anchors the
  // surface by them, so a second copy of either is the avatar drawn somewhere
  // main did not put it. Each already answers for both card directions, which
  // is what lets a flip move the canvas rather than resize it.
  const dropBelow = companionNearEdgeFor(avatarBox, optionsBox);
  const canvasHeight = Math.round(
    companionCardSideFor(avatarBox, optionsBox) + dropBelow,
  );
  // The near edge is taken exactly as the contract states it and the card's
  // side absorbs the rounding, because the renderer names the card's edge with
  // `100%` and steps back from it by that near edge. Rounding the other way
  // round would leave main placing the window by one line and the renderer
  // drawing the creature on another, and a card side is a ceiling with slack in
  // it where a near edge is the line itself.
  const riseAbove = canvasHeight - dropBelow;
  // Twice a whole half rather than a whole total. The renderer puts the
  // avatar on the canvas's centre line, so an odd width would stand the
  // creature on a half point and a resize would not land back on it.
  const canvasWidth = Math.round(maxReach + pad) * 2;
  if (companionDockIsSide(dock)) {
    // Half the column's greatest length, then the gap and the whole of the
    // creature standing at its end, then the pad: the same reach the width
    // holds for the row, read up from the avatar's centre. Whole for the
    // reason the width is twice a whole half.
    const sideHalf = Math.round(maxPillWidth / 2 + gap + avatarBox + pad);
    // Across, the capture picker stands beside the column rather than over
    // it, so the side facing the middle of the screen holds the column's
    // cross reach, the gap and the whole card. The other side hangs off the
    // display's edge, where a wider canvas costs nothing.
    const pickerReach = Math.round(
      companionLowerReachFor(avatarBox, optionsBox) +
        gap +
        COMPANION_BASE_CAPTURE_PICKER_WIDTH * companionScaleFor(optionsBox) +
        pad,
    );
    return {
      avatarBox,
      optionsBox,
      canvasWidth: Math.max(canvasWidth, pickerReach * 2),
      canvasHeight: sideHalf * 2,
      riseAbove: sideHalf,
      dropBelow: sideHalf,
      maxReach,
    };
  }
  // A popover drawn on a call's bar stands on the bar's centre line and can
  // be taller than the card the canvas keeps room for, so the card's side
  // grows to hold it. Only that side: the near edge is the bar's, unchanged.
  const heldRise = Math.max(riseAbove, Math.round(attachedRise));
  return {
    avatarBox,
    optionsBox,
    canvasWidth,
    canvasHeight: heldRise + dropBelow,
    riseAbove: heldRise,
    dropBelow,
    maxReach,
  };
};

/**
 * Gap between the creature's visible bottom and the work area's bottom edge on
 * the first ever launch.
 *
 * From the *visible* bottom, not the avatar's box. The box runs a good way
 * past the artwork on every side to hold the glow and the bob's slack (see
 * `companionBaselineFor`), so a margin measured against it would be this gap
 * plus however much slack the current size carries, growing with every step of
 * the scale.
 *
 * Small, because the surface floats over whatever the user is working in and
 * the bottom of a window is where that application keeps its own controls. A
 * companion resting a finger's width above the work area is a companion in
 * front of the thing it was put there to help with. Resting on that edge
 * leaves it a strip of its own under everything else, which is the shape of
 * the bargain: seen when looked for, out of the way when not.
 *
 * Two points rather than none. The clamp takes the creature all the way down
 * to the edge and a drag can put it there, but opening flush against it leaves
 * the lit rim's own bloom with nowhere to fall, and a glow cut off by the
 * bottom of the display reads as the surface being clipped rather than as it
 * resting on something.
 */
const DEFAULT_MARGIN = 2;

/**
 * Which way the pill grows, from where the avatar actually sits.
 *
 * The room on each side is measured from the avatar's centre, so the clearance
 * the pill needs is measured from there too: the avatar's half box, then the
 * gap, then the widest the pill draws, which is
 * {@link CompanionGeometry.maxReach}.
 * Rightward is the default and leftward is what it flips to when the right edge
 * is too close, so the avatar stays exactly where the user put it instead of
 * the controls running off the display.
 *
 * A display too narrow for either direction still grows right, because the
 * clipping is then unavoidable and the user can drag the surface somewhere it
 * fits.
 */
export const growthFor = (
  avatarCentreX: number,
  workArea: { x: number; width: number },
  geometry: CompanionGeometry,
): CompanionGrowth => {
  const needed = geometry.maxReach;
  const roomRight = workArea.x + workArea.width - avatarCentreX;
  const roomLeft = avatarCentreX - workArea.x;
  if (roomRight < needed && roomLeft >= needed) {
    return "left";
  }
  return "right";
};

/**
 * Which way the card unfurls, from the room the display has above the avatar.
 *
 * The vertical {@link growthFor}. Growing upward
 * needs `riseAbove` of canvas above the avatar's centre, and macOS will
 * not put that canvas above the top of the work area, so near the top of a
 * display the card has to grow the other way instead.
 *
 * Where {@link growthFor} falls back to its designed direction when neither
 * fits, this falls back to the other one, because the two are not paying the
 * same price. A canvas may hang off the left and right of a display freely, so
 * a bad horizontal guess only clips the card. It may not hang off the top, so a
 * bad vertical guess pushes the *avatar* down by the whole reserved height and
 * fences it out of the top of the screen, which is the bug this exists to fix,
 * in miniature. On a display too short for the card either way the card is
 * already lost, and what is worth saving is the mascot's reach.
 */
export const cardGrowthFor = (
  avatarCentreY: number,
  workArea: { y: number; height: number },
  geometry: CompanionGeometry,
): CompanionCardGrowth =>
  avatarCentreY - workArea.y >= geometry.riseAbove ? "up" : "down";

/**
 * Where the avatar's centre sits inside the canvas, measured from its top.
 *
 * The one number the renderer and main have to agree on for the surface to be
 * drawn where the window was put. Published with the direction rather than
 * recomputed on the other side, so there is one derivation of it.
 */
export const avatarOffsetFor = (
  cardGrowth: CompanionCardGrowth,
  geometry: CompanionGeometry,
): number => (cardGrowth === "up" ? geometry.riseAbove : geometry.dropBelow);

/**
 * Where to put the canvas so the avatar lands on a given point, and which way
 * the card unfurls once it is there.
 *
 * Everything is computed in the avatar's coordinates and converted to a window
 * origin at the last step. Working the other way round (nudging the origin and
 * reading the avatar out of it) is what made the direction flip impossible to
 * do mid-drag: the avatar's offset inside the canvas changes with the
 * direction, so the same origin means two different avatar positions, and a
 * drag that crossed the threshold would teleport the mascot by the difference.
 *
 * **The avatar is what is kept on screen, not the canvas.** The canvas reaches
 * hundreds of points past the avatar to hold a pill that is usually not drawn,
 * and clamping that box would fence the avatar into the middle of the display,
 * unable to reach the corner it is meant to rest in.
 *
 * **The origin is never asked for above the work area.** macOS silently refuses
 * such a position and hands back one flush with the work area's top, which
 * moves the avatar somewhere neither side chose. Asking only for positions the
 * window server will honour is what keeps main's idea of where the avatar is
 * equal to where it actually is.
 *
 * Exported for its tests, as {@link growthFor} is, and pure for the same
 * reason: it is the rule that decides whether the surface can be lost.
 */
export const placeCanvas = (
  avatarCentre: { x: number; y: number },
  workArea: { x: number; y: number; width: number; height: number },
  geometry: CompanionGeometry,
): { origin: { x: number; y: number }; cardGrowth: CompanionCardGrowth } => {
  // Half the avatar may hang past the edge, so the clamp is to its centre plus
  // a half box. A work area smaller than the avatar would put the maximum below
  // the minimum, which `Math.min` then resolves toward the top-left corner
  // rather than producing a position outside the display.
  const half = geometry.avatarBox / 2;
  // Downward the clamp is the lowest thing the surface can draw, not its box.
  // The box holds the glow and the bob's slack, and slack is not something the
  // user can see: clamping to it stops the surface short of the edge by
  // however much of it is empty. Reading the creature's artwork alone is the
  // other mistake, since a pointer grows a pill around it and a call stands a
  // bar on the same point, both of which reach lower. See
  // `companionLowerReachFor`. Upward and sideways the box still decides: the
  // canvas above has its own bound below, and the sides are where a half box
  // is deliberately allowed to hang past the edge.
  const reach = companionLowerReachFor(geometry.avatarBox, geometry.optionsBox);
  const minCentreX = workArea.x + half;
  const maxCentreX = workArea.x + workArea.width - half;
  const minCentreY = workArea.y + half;
  const maxCentreY = workArea.y + workArea.height - reach;
  const centreX = Math.min(Math.max(avatarCentre.x, minCentreX), maxCentreX);
  const wantedY = Math.min(Math.max(avatarCentre.y, minCentreY), maxCentreY);

  const cardGrowth = cardGrowthFor(wantedY, workArea, geometry);
  const offset = avatarOffsetFor(cardGrowth, geometry);
  // The last of the three bounds, and the one macOS would otherwise apply
  // itself: the canvas above the avatar has to fit under the work area's top.
  const centreY = Math.max(wantedY, workArea.y + offset);

  return {
    origin: {
      x: Math.round(centreX - geometry.canvasWidth / 2),
      y: Math.round(centreY - offset),
    },
    cardGrowth,
  };
};

/**
 * Where the avatar's centre goes with no remembered position: the bottom
 * centre of the work area, a margin up from its edge. Centred so the pill has
 * room to grow either way, and low so it sits under the window the user is
 * working in rather than over it.
 *
 * The margin is measured to the lowest thing the surface can draw from this
 * point, so the same gap is left under it at every size and in every state it
 * can enter without the window moving. See {@link DEFAULT_MARGIN} and
 * `companionLowerReachFor`.
 *
 * Exported for its tests and pure for the same reason as {@link placeCanvas}.
 */
export const defaultAvatarCentre = (
  workArea: { x: number; y: number; width: number; height: number },
  geometry: CompanionGeometry,
): { x: number; y: number } => ({
  x: workArea.x + workArea.width / 2,
  y:
    workArea.y +
    workArea.height -
    DEFAULT_MARGIN -
    companionLowerReachFor(geometry.avatarBox, geometry.optionsBox),
});

/**
 * Where the avatar's centre goes for a call docked to an edge of the display.
 *
 * The bottom is {@link defaultAvatarCentre}, which is where every call has
 * ever put the bar. The top is asked for at the work area's own top line and
 * left to {@link placeCanvas} to settle as high as the window server allows,
 * since the canvas above the avatar is what decides that and the clamp already
 * knows it. The sides stand the bar up as a column centred on the avatar, so
 * the avatar goes to the display's vertical centre and the same margin in from
 * the edge the bottom keeps up from its own: the column's cross reach is the
 * bar's half box and its lit edge, which is the same number the bottom
 * measures its margin from (see `companionLowerReachFor`).
 *
 * Exported for its tests and pure for the same reason as {@link placeCanvas}.
 */
export const dockedAvatarCentre = (
  dock: CompanionDock,
  workArea: { x: number; y: number; width: number; height: number },
  geometry: CompanionGeometry,
): { x: number; y: number } => {
  const reach = companionLowerReachFor(geometry.avatarBox, geometry.optionsBox);
  switch (dock) {
    case "bottom":
      return defaultAvatarCentre(workArea, geometry);
    case "top":
      return { x: workArea.x + workArea.width / 2, y: workArea.y };
    case "left":
      return {
        x: workArea.x + DEFAULT_MARGIN + reach,
        y: workArea.y + workArea.height / 2,
      };
    case "right":
      return {
        x: workArea.x + workArea.width - DEFAULT_MARGIN - reach,
        y: workArea.y + workArea.height / 2,
      };
  }
};

/**
 * The edge a bar dropped at a point would dock to: whichever of the four is
 * closest to it.
 *
 * Plain distance rather than a fraction of the display's size, so the answer
 * is the edge the hand is nearest, which is the edge it was dragging toward.
 * A point equally far from two edges goes to the earlier of the two in the
 * order the docks are named, which puts the bottom first: it is the edge the
 * bar is designed around, so a tie resolves to the shape the user already
 * knows.
 *
 * Exported for its tests, as {@link growthFor} is.
 */
export const nearestDock = (
  point: { x: number; y: number },
  workArea: { x: number; y: number; width: number; height: number },
): CompanionDock => {
  const distances: [CompanionDock, number][] = [
    ["bottom", workArea.y + workArea.height - point.y],
    ["top", point.y - workArea.y],
    ["left", point.x - workArea.x],
    ["right", workArea.x + workArea.width - point.x],
  ];
  return distances.reduce((nearest, candidate) =>
    candidate[1] < nearest[1] ? candidate : nearest,
  )[0];
};
