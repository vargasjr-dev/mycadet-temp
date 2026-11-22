import { describe, expect, test } from "bun:test";
import {
  COMPANION_BASE_AVATAR_BOX,
  COMPANION_BASE_CAPTURE_PICKER_WIDTH,
  COMPANION_BASE_MAX_PILL_WIDTH,
  COMPANION_BASE_RESTING_PILL_HEIGHT,
  COMPANION_SIZES,
  companionBoxFor,
  companionCardSideFor,
  companionGapFor,
  companionLowerReachFor,
  companionNearEdgeFor,
  companionScaleFor,
  type CompanionDock,
  type CompanionSize,
} from "@mycadet/ipc-contract";
import {
  avatarOffsetFor,
  cardGrowthFor,
  defaultAvatarCentre,
  dockedAvatarCentre,
  geometryFor,
  growthFor,
  nearestDock,
  placeCanvas,
} from "./companion-geometry";

/**
 * The size the placement cases are written against, which is the one the
 * renderer's layout is authored at. Every other size is the same arithmetic
 * scaled, which `geometryFor` has its own cases for.
 */
const GEOMETRY = geometryFor("small", "small");
const RISE_ABOVE = GEOMETRY.riseAbove;
const DROP_BELOW = GEOMETRY.dropBelow;

/** A creature far larger than the controls beside it, and the reverse. */
const BIG_CREATURE = geometryFor("huge", "small");
const BIG_OPTIONS = geometryFor("small", "huge");

/**
 * The part of the base reach the geometry does not publish: the pill's widest,
 * at the options size {@link GEOMETRY} is drawn in. Bound to the contract for
 * the cases that are about it rather than the sum.
 */
const MAX_PILL_WIDTH =
  COMPANION_BASE_MAX_PILL_WIDTH * companionScaleFor(GEOMETRY.optionsBox);

/**
 * The growth direction is the only rule in the companion window worth testing
 * without a window server: everything else is Electron plumbing. It decides
 * which way the pill unfurls out of the avatar, and getting it wrong runs the
 * controls off the side of the display.
 */

// A 1440pt display with no menu-bar offset, which keeps the arithmetic in the
// cases readable.
const DISPLAY = { x: 0, width: 1440 };

// The clearance the pill needs on the side it grows into, measured from the
// avatar's centre the way the room on each side is: the avatar's half box, the
// gap, then the widest body.
const NEEDED = GEOMETRY.maxReach;

const SCREEN = { x: 0, y: 0, width: 1440, height: 900 };
const SIDE = geometryFor("small", "small", "left");

/** Where a dock lands the avatar, read back the way `avatarCentre` reads it. */
const landing = (
  dock: CompanionDock,
  geometry: typeof GEOMETRY = GEOMETRY,
): { x: number; y: number } => {
  const placed = placeCanvas(
    dockedAvatarCentre(dock, SCREEN, geometry),
    SCREEN,
    geometry,
  );
  return {
    x: placed.origin.x + geometry.canvasWidth / 2,
    y: placed.origin.y + avatarOffsetFor(placed.cardGrowth, geometry),
  };
};

describe("growthFor", () => {
  test("grows rightward with room to the right", () => {
    expect(growthFor(720, DISPLAY, GEOMETRY)).toBe("right");
  });

  test("still grows rightward hard against the left edge", () => {
    // Growth runs away from the edge here, so there is nothing to flip.
    expect(growthFor(40, DISPLAY, GEOMETRY)).toBe("right");
  });

  test("flips leftward when the right runs out", () => {
    expect(growthFor(1400, DISPLAY, GEOMETRY)).toBe("left");
  });

  test("exactly enough room on the right still grows rightward", () => {
    expect(growthFor(DISPLAY.width - NEEDED, DISPLAY, GEOMETRY)).toBe("right");
  });

  test("one pixel short on the right flips", () => {
    expect(growthFor(DISPLAY.width - NEEDED + 1, DISPLAY, GEOMETRY)).toBe(
      "left",
    );
  });

  /**
   * The gap and the avatar's half box are part of the clearance, not slack the
   * pill can be squeezed into. A test measured against the body alone would
   * pass with the pill's leading edge already off the display.
   */
  test("counts the gap and the half box as room the pill needs", () => {
    expect(growthFor(DISPLAY.width - MAX_PILL_WIDTH, DISPLAY, GEOMETRY)).toBe(
      "left",
    );
  });

  /**
   * The room is measured from the avatar's centre while the pill starts at the
   * avatar's edge, so the half box is the difference between fitting and
   * clipping. Room enough for the gap and the widest body still cuts the
   * controls off.
   */
  test("flips when only the avatar's half box is missing on the right", () => {
    expect(
      growthFor(
        DISPLAY.width - (NEEDED - GEOMETRY.avatarBox / 2),
        DISPLAY,
        GEOMETRY,
      ),
    ).toBe("left");
  });

  test("measures against the display's own origin, not the screen's", () => {
    // A second display to the right of the primary. Its right edge is 2880, so
    // an avatar near it has no room even though its absolute x is large.
    const secondary = { x: 1440, width: 1440 };
    expect(growthFor(2840, secondary, GEOMETRY)).toBe("left");
    expect(growthFor(1600, secondary, GEOMETRY)).toBe("right");
  });

  test("a display too narrow for either direction still grows right", () => {
    // The clipping is unavoidable, and the user can drag the surface somewhere
    // it fits. Flipping would only move which end is cut off.
    const narrow = { x: 0, width: 200 };
    expect(growthFor(100, narrow, GEOMETRY)).toBe("right");
  });
});

/**
 * The clamp is the other half of that: growth decides which way the pill
 * unfurls, and this decides whether the avatar it unfurls from is still
 * somewhere the user can reach. A surface pushed off the display cannot be
 * dragged back, because there is nothing left on screen to grab.
 */

/** A 1440x900 display with the menu bar taken off the top. */
const WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };

/** Where the avatar's centre ends up for a given placement. */
const centreOf = (
  placed: ReturnType<typeof placeCanvas>,
  geometry = GEOMETRY,
) => ({
  x: placed.origin.x + geometry.canvasWidth / 2,
  y: placed.origin.y + avatarOffsetFor(placed.cardGrowth, geometry),
});

describe("the room kept under the surface", () => {
  /**
   * The window is placed once and does not move when the pointer arrives or a
   * call starts, so the room under it answers for every state it can enter
   * from there. Each of the three is the lowest at some size.
   */
  test("clears the pill a pointer grows, not only the creature", () => {
    const centre = defaultAvatarCentre(WORK_AREA, GEOMETRY);
    const grownPill =
      centre.y +
      (COMPANION_BASE_RESTING_PILL_HEIGHT / 2) *
        companionScaleFor(GEOMETRY.avatarBox);

    expect(grownPill).toBeLessThanOrEqual(25 + 875);
  });

  test("clears the call's bar, which the options box sizes", () => {
    for (const geometry of [GEOMETRY, BIG_OPTIONS]) {
      const centre = defaultAvatarCentre(WORK_AREA, geometry);
      expect(centre.y + geometry.optionsBox / 2).toBeLessThanOrEqual(25 + 875);
    }
  });

  /** And a drag can put the surface no lower than the same rule allows. */
  test("holds a drag to the same room", () => {
    const dragged = centreOf(
      placeCanvas({ x: 700, y: 9000 }, WORK_AREA, GEOMETRY),
    );
    expect(dragged.y).toBe(
      900 - companionLowerReachFor(GEOMETRY.avatarBox, GEOMETRY.optionsBox),
    );
  });
});

describe("placeCanvas", () => {
  test("puts the avatar exactly where a position inside the work area asks", () => {
    expect(
      centreOf(placeCanvas({ x: 700, y: 500 }, WORK_AREA, GEOMETRY)),
    ).toEqual({
      x: 700,
      y: 500,
    });
  });

  test("holds the avatar at the right edge rather than past it", () => {
    expect(
      centreOf(placeCanvas({ x: 9000, y: 500 }, WORK_AREA, GEOMETRY)).x,
    ).toBe(1440 - 22);
  });

  test("holds the avatar at the left edge rather than past it", () => {
    expect(
      centreOf(placeCanvas({ x: -9000, y: 500 }, WORK_AREA, GEOMETRY)).x,
    ).toBe(22);
  });

  /**
   * The lowest thing the surface can draw lands on the edge, not its box. The
   * box carries the glow and the bob's slack, and stopping short of the edge
   * by however much of it is empty reads as the surface refusing to go where
   * it is dragged. See `companionLowerReachFor` for what is measured instead.
   */
  test("holds the surface's lowest ink on the bottom edge", () => {
    expect(
      centreOf(placeCanvas({ x: 700, y: 9000 }, WORK_AREA, GEOMETRY)).y,
    ).toBe(
      900 - companionLowerReachFor(GEOMETRY.avatarBox, GEOMETRY.optionsBox),
    );
  });

  /** And the slack grows with the creature, so the rule has to be read per size. */
  test("reads that bottom off the size the creature is drawn at", () => {
    expect(
      centreOf(
        placeCanvas({ x: 700, y: 9000 }, WORK_AREA, BIG_CREATURE),
        BIG_CREATURE,
      ).y,
    ).toBe(
      900 -
        companionLowerReachFor(BIG_CREATURE.avatarBox, BIG_CREATURE.optionsBox),
    );
  });

  /**
   * The canvas is far wider than the avatar, so a clamp written against the
   * canvas box would refuse to let the avatar anywhere near the edge. The
   * corner is exactly where the surface is meant to rest.
   */
  test("lets the avatar reach the corner the surface opens in", () => {
    const reach = companionLowerReachFor(
      GEOMETRY.avatarBox,
      GEOMETRY.optionsBox,
    );
    expect(
      centreOf(
        placeCanvas({ x: 1440 - 22, y: 900 - reach }, WORK_AREA, GEOMETRY),
      ),
    ).toEqual({ x: 1440 - 22, y: 900 - reach });
  });

  test("clamps against the display it is given, not the primary one", () => {
    const secondary = { x: 1440, y: 0, width: 1920, height: 1080 };
    expect(
      centreOf(placeCanvas({ x: 99999, y: 500 }, secondary, GEOMETRY)).x,
    ).toBe(1440 + 1920 - 22);
  });

  /**
   * A work area smaller than the canvas cannot hold the avatar inside it and
   * keep the origin on screen, and the origin is the one macOS enforces. So the
   * honest guarantee is bounded, not exact: the surface does not fly off to
   * where the fling asked, and it asks for nothing the window server will
   * quietly rewrite. Asserting the avatar lands inside a 10pt display would be
   * asserting arithmetic that never survives contact with AppKit.
   */
  test("stays near a work area too small to hold the canvas", () => {
    const tiny = { x: 0, y: 0, width: 10, height: 10 };
    const placed = placeCanvas({ x: 9000, y: 9000 }, tiny, GEOMETRY);
    expect(placed.origin.y).toBeGreaterThanOrEqual(tiny.y);
    expect(centreOf(placed).x).toBeLessThanOrEqual(10);
    expect(centreOf(placed).y).toBeLessThanOrEqual(tiny.y + DROP_BELOW);
  });

  /**
   * JARVIS-1548. macOS refuses a window origin above the top of the work area
   * and hands back one flush with it, so an origin asked for any higher moves
   * the avatar somewhere neither side chose. Every position this returns has to
   * be one the window server will actually honour.
   */
  test("never asks for an origin above the work area", () => {
    for (const y of [-9000, -100, 0, 25, 40, 70, 71, 200, 400]) {
      expect(
        placeCanvas({ x: 700, y }, WORK_AREA, GEOMETRY).origin.y,
      ).toBeGreaterThanOrEqual(WORK_AREA.y);
    }
  });

  /**
   * The bug as the user met it: the avatar stopped hundreds of points short of
   * the top for no visible reason. It was the canvas's upper half, which the
   * old symmetric canvas spent on a card that had nowhere to grow.
   */
  test("brings the avatar within a shadow's width of the top", () => {
    const centre = centreOf(
      placeCanvas({ x: 700, y: -9000 }, WORK_AREA, GEOMETRY),
    );
    expect(centre.y).toBe(WORK_AREA.y + DROP_BELOW);
    // Where it used to stop: the old canvas's half-height below the work area.
    expect(centre.y).toBeLessThan(WORK_AREA.y + RISE_ABOVE);
  });
});

describe("defaultAvatarCentre", () => {
  /**
   * The margin is to the creature's visible bottom, so it is the same gap off
   * the edge at every size rather than that gap plus the box's own slack.
   */
  test("opens a margin above the work area's bottom edge", () => {
    const centre = defaultAvatarCentre(WORK_AREA, GEOMETRY);
    expect(centre.x).toBe(720);
    expect(centre.y).toBe(
      25 +
        875 -
        2 -
        companionLowerReachFor(GEOMETRY.avatarBox, GEOMETRY.optionsBox),
    );
  });

  /**
   * The gap a user actually sees, which is the whole point of measuring it
   * this way: the same 8pt under a creature at any size.
   */
  test("leaves the same visible gap at every size", () => {
    for (const geometry of [GEOMETRY, BIG_CREATURE, BIG_OPTIONS]) {
      const centre = defaultAvatarCentre(WORK_AREA, geometry);
      const visibleBottom =
        centre.y +
        companionLowerReachFor(geometry.avatarBox, geometry.optionsBox);
      expect(25 + 875 - visibleBottom).toBe(2);
    }
  });

  test("centres on the display it is given, not the primary one", () => {
    const secondary = { x: 1440, y: 0, width: 2560, height: 1415 };
    expect(defaultAvatarCentre(secondary, GEOMETRY).x).toBe(1440 + 1280);
  });

  test("lands where placeCanvas leaves it alone", () => {
    const wanted = defaultAvatarCentre(WORK_AREA, GEOMETRY);
    expect(centreOf(placeCanvas(wanted, WORK_AREA, GEOMETRY))).toEqual(wanted);
  });
});

describe("cardGrowthFor", () => {
  test("grows up with room for the card above the avatar", () => {
    expect(cardGrowthFor(500, WORK_AREA, GEOMETRY)).toBe("up");
  });

  test("grows down when the card would not fit above", () => {
    expect(cardGrowthFor(WORK_AREA.y + 40, WORK_AREA, GEOMETRY)).toBe("down");
  });

  test("flips exactly where the card stops fitting", () => {
    expect(cardGrowthFor(WORK_AREA.y + RISE_ABOVE, WORK_AREA, GEOMETRY)).toBe(
      "up",
    );
    expect(
      cardGrowthFor(WORK_AREA.y + RISE_ABOVE - 1, WORK_AREA, GEOMETRY),
    ).toBe("down");
  });

  /**
   * Deliberately *not* the twin of "a display too narrow for either direction
   * still grows right". A canvas may hang off the sides of a display but not
   * off the top, so falling back to `up` here would reserve 292pt above an
   * avatar that has nowhere to put it and fence the mascot out of the top of a
   * short display. The card is already lost either way; the reach is not.
   */
  test("grows down on a display too short for the card either way", () => {
    const short = { y: 0, height: 100 };
    expect(cardGrowthFor(50, short, GEOMETRY)).toBe("down");
  });

  test("does not flip near the bottom, which is where the surface lives", () => {
    expect(cardGrowthFor(900 - 22, WORK_AREA, GEOMETRY)).toBe("up");
  });
});

describe("avatarOffsetFor", () => {
  /**
   * The avatar's offset is what converts a window origin into an avatar
   * position on both sides of the bridge. Growing up reserves the card's height
   * above it; growing down reserves only the avatar and its shadow.
   */
  test("reserves the card's height above the avatar when growing up", () => {
    expect(avatarOffsetFor("up", GEOMETRY)).toBe(RISE_ABOVE);
  });

  test("reserves only the shadow above it when growing down", () => {
    expect(avatarOffsetFor("down", GEOMETRY)).toBe(DROP_BELOW);
  });
});

describe("geometryFor", () => {
  test("builds the ordinary canvas for the top and bottom", () => {
    expect(geometryFor("small", "small", "top")).toEqual(GEOMETRY);
    expect(geometryFor("small", "small", "bottom")).toEqual(GEOMETRY);
  });

  /**
   * The column is centred on the avatar, so the canvas has to reach as far
   * below it as above; and it has to hold half the column, the gap and the
   * whole creature standing at its end.
   */
  test("builds a canvas symmetric about the avatar for a side", () => {
    for (const dock of ["left", "right"] as const) {
      const side = geometryFor("small", "small", dock);
      expect(side.riseAbove).toBe(side.dropBelow);
      expect(side.canvasHeight).toBe(side.riseAbove * 2);
      const scale = companionScaleFor(side.optionsBox);
      expect(side.riseAbove).toBeGreaterThanOrEqual(
        (COMPANION_BASE_MAX_PILL_WIDTH * scale) / 2 + side.avatarBox,
      );
    }
  });

  /**
   * The capture picker stands beside the column, facing the middle of the
   * screen, so half the canvas has to hold the column's cross reach, the
   * gap and the whole card. Never narrower than the row's canvas.
   */
  test("reaches past the column far enough to hold the capture picker", () => {
    for (const [avatar, options] of [
      ["small", "small"],
      ["huge", "small"],
      ["small", "huge"],
    ] as const) {
      const side = geometryFor(avatar, options, "left");
      const row = geometryFor(avatar, options);
      expect(side.canvasWidth).toBeGreaterThanOrEqual(row.canvasWidth);
      expect(side.canvasWidth / 2).toBeGreaterThanOrEqual(
        companionLowerReachFor(side.avatarBox, side.optionsBox) +
          companionGapFor(side.avatarBox, side.optionsBox) +
          COMPANION_BASE_CAPTURE_PICKER_WIDTH *
            companionScaleFor(side.optionsBox),
      );
    }
  });
});

describe("dockedAvatarCentre", () => {
  test("is the bottom centre for the bottom", () => {
    expect(dockedAvatarCentre("bottom", SCREEN, GEOMETRY)).toEqual(
      defaultAvatarCentre(SCREEN, GEOMETRY),
    );
  });

  /** As high as the canvas above the avatar lets the window server go. */
  test("settles as high as the work area allows for the top", () => {
    const top = landing("top");
    expect(top.x).toBe(SCREEN.width / 2);
    expect(top.y).toBe(SCREEN.y + DROP_BELOW);
  });

  test("stands the sides at the display's vertical centre, a margin in", () => {
    const reach = companionLowerReachFor(SIDE.avatarBox, SIDE.optionsBox);
    expect(dockedAvatarCentre("left", SCREEN, SIDE)).toEqual({
      x: 2 + reach,
      y: SCREEN.height / 2,
    });
    expect(dockedAvatarCentre("right", SCREEN, SIDE)).toEqual({
      x: SCREEN.width - 2 - reach,
      y: SCREEN.height / 2,
    });
  });
});

describe("nearestDock", () => {
  test("is the edge the point is closest to", () => {
    expect(nearestDock({ x: 700, y: 850 }, SCREEN)).toBe("bottom");
    expect(nearestDock({ x: 700, y: 40 }, SCREEN)).toBe("top");
    expect(nearestDock({ x: 30, y: 450 }, SCREEN)).toBe("left");
    expect(nearestDock({ x: 1400, y: 450 }, SCREEN)).toBe("right");
  });

  test("resolves a tie to the bottom, the shape the bar is designed around", () => {
    expect(nearestDock({ x: 720, y: 450 }, SCREEN)).toBe("bottom");
  });

  test("measures against the work area it is given, not the origin", () => {
    const second = { x: 1440, y: 0, width: 1920, height: 1080 };
    expect(nearestDock({ x: 1460, y: 500 }, second)).toBe("left");
  });
});

describe("geometryFor", () => {
  /**
   * What the width is actually for: the avatar's half box, the gap the pill
   * hangs off it by, and the widest the pill draws, on both sides so main can
   * flip the direction without resizing the window, plus the shadow's room.
   *
   * Stated as the numbers each step comes to rather than as the sum again. Each
   * one is a canvas that was looked at, and a formula repeated here would pass
   * against any change to the formula it repeats.
   */
  test("holds the pill's whole reach on both sides of the avatar", () => {
    const canvases: Record<
      CompanionSize,
      { maxReach: number; canvasWidth: number; canvasHeight: number }
    > = {
      small: { maxReach: 322, canvasWidth: 692, canvasHeight: 306 },
      medium: { maxReach: 445, canvasWidth: 962, canvasHeight: 435 },
      large: { maxReach: 662, canvasWidth: 1420, canvasHeight: 624 },
      huge: { maxReach: 879, canvasWidth: 1878, canvasHeight: 813 },
      ridiculous: { maxReach: 1140, canvasWidth: 2520, canvasHeight: 1230 },
    };
    for (const size of COMPANION_SIZES) {
      const { maxReach, canvasWidth, canvasHeight } = geometryFor(size, size);
      expect({ maxReach, canvasWidth, canvasHeight }).toEqual(canvases[size]);
    }
  });

  /**
   * The creature's box is the avatar axis's answer and nothing else's. It is
   * what main clamps by, so a pill size leaking into it would move where the
   * mascot is allowed to sit.
   */
  test("takes the creature's box from the avatar axis alone", () => {
    for (const options of COMPANION_SIZES) {
      expect(geometryFor("large", options).avatarBox).toBe(
        companionBoxFor("avatar", "large"),
      );
    }
  });

  /**
   * Everything beside the creature is the options axis's answer, starting with
   * the pill's own box.
   */
  test("takes the pill's box from the options axis alone", () => {
    for (const avatar of COMPANION_SIZES) {
      expect(geometryFor(avatar, "large").optionsBox).toBe(
        companionBoxFor("options", "large"),
      );
    }
  });

  /**
   * The two sides of the avatar at each step, as the numbers they come to.
   *
   * Not one scale times the authored pair: a name is a creature and a pill a
   * notch apart, so the two sides move at different rates and each step is its
   * own canvas. The authored pair is stated first, since each of these is that
   * one layout scaled.
   */
  test("states both sides of the avatar at every named step", () => {
    // The pill's bottom sits 14 under the avatar's centre, so its top stands
    // 30 over it where the creature's box reaches only 22, and the card rises
    // its whole height off that same line. Both sides then take the pad.
    expect(
      companionNearEdgeFor(
        COMPANION_BASE_AVATAR_BOX,
        COMPANION_BASE_AVATAR_BOX,
      ),
    ).toBe(54);
    expect(
      companionCardSideFor(
        COMPANION_BASE_AVATAR_BOX,
        COMPANION_BASE_AVATAR_BOX,
      ),
    ).toBe(332);
    const sides: Record<
      CompanionSize,
      { riseAbove: number; dropBelow: number }
    > = {
      small: { riseAbove: 260, dropBelow: 46 },
      medium: { riseAbove: 366, dropBelow: 69 },
      large: { riseAbove: 532, dropBelow: 92 },
      huge: { riseAbove: 698, dropBelow: 115 },
      ridiculous: { riseAbove: 1000, dropBelow: 230 },
    };
    for (const size of COMPANION_SIZES) {
      const { riseAbove, dropBelow } = geometryFor(size, size);
      expect({ riseAbove, dropBelow }).toEqual(sides[size]);
    }
  });

  test("grows monotonically through the named steps", () => {
    const boxes = COMPANION_SIZES.map(
      (size) => geometryFor(size, size).avatarBox,
    );
    expect(boxes).toEqual([...boxes].sort((a, b) => a - b));
    expect(new Set(boxes).size).toBe(boxes.length);
  });

  /**
   * The canvas is a window size, and a window cannot be a fraction of a point.
   * The two offsets are whole points too, and the width is even: the avatar
   * sits on the canvas's centre line and on the line between the offsets, so a
   * fraction anywhere here stands the creature on a half point that a resize
   * cannot land back on. The options axis is where this bites, since its
   * smaller steps are not whole multiples of the box the layout is authored at.
   */
  test("gives every size a whole-point canvas", () => {
    for (const size of COMPANION_SIZES) {
      const geometry = geometryFor(size, size);
      expect(Number.isInteger(geometry.canvasWidth)).toBe(true);
      expect(Number.isInteger(geometry.canvasHeight)).toBe(true);
      expect(Number.isInteger(geometry.riseAbove)).toBe(true);
      expect(Number.isInteger(geometry.dropBelow)).toBe(true);
      expect(Number.isInteger(geometry.maxReach)).toBe(true);
      expect(geometry.canvasWidth % 2).toBe(0);
    }
  });

  /**
   * The asymmetry that JARVIS-1548 bought has to survive being scaled: the card
   * side reserves its height, the other side reserves the avatar and its
   * shadow, and the second stays much the smaller of the two at every size.
   */
  test("keeps the canvas asymmetric about the avatar at every size", () => {
    for (const size of COMPANION_SIZES) {
      const geometry = geometryFor(size, size);
      expect(geometry.dropBelow).toBeLessThan(geometry.riseAbove);
      expect(geometry.riseAbove + geometry.dropBelow).toBe(
        geometry.canvasHeight,
      );
    }
  });
});

describe("geometryFor with the two axes apart", () => {
  const MIXED = [BIG_CREATURE, BIG_OPTIONS];

  test("spends the whole canvas on the two sides of the avatar", () => {
    for (const geometry of MIXED) {
      expect(geometry.riseAbove + geometry.dropBelow).toBe(
        geometry.canvasHeight,
      );
      expect(geometry.dropBelow).toBeLessThan(geometry.riseAbove);
      expect(Number.isInteger(geometry.canvasHeight)).toBe(true);
    }
  });

  /**
   * Each mix as the canvas it comes to rather than as the formula repeated,
   * since a formula restated here would pass against any change to the formula
   * it restates.
   *
   * The width is where the gap rule shows: the gap is breathing room, so the
   * smaller of the two boxes decides how much of it there is, and the creature
   * below takes its small pill's gap rather than the chasm its own scale would
   * ask for, which would put its reach at 376. The two heights are the two
   * sides of the avatar: the near edge clears the creature's box and the pill's
   * top alike, and the far edge clears the card growing either way.
   */
  test("holds the pill, the card and the creature at each mix", () => {
    // An enormous creature's half box, the gap its small pill earns, and that
    // pill at its widest.
    expect(BIG_CREATURE).toEqual({
      avatarBox: 110,
      optionsBox: 32,
      maxReach: 355,
      canvasWidth: 830,
      riseAbove: 362,
      dropBelow: 115,
      canvasHeight: 477,
    });
    // A base half box, the base gap, and a pill twice as wide.
    expect(BIG_OPTIONS).toEqual({
      avatarBox: 44,
      optionsBox: 88,
      maxReach: 834,
      canvasWidth: 1764,
      riseAbove: 614,
      dropBelow: 122,
      canvasHeight: 736,
    });
  });

  test("flips the pill at the reach the options size asks for", () => {
    expect(
      growthFor(DISPLAY.width - BIG_CREATURE.maxReach, DISPLAY, BIG_CREATURE),
    ).toBe("right");
    expect(
      growthFor(
        DISPLAY.width - BIG_CREATURE.maxReach + 1,
        DISPLAY,
        BIG_CREATURE,
      ),
    ).toBe("left");
  });

  /**
   * A display too narrow for the pill either way still grows the designed way,
   * and an enormous options size beside a small creature is how a 1440pt
   * display gets there.
   */
  test("still grows the designed way where neither side can hold the pill", () => {
    const enormousOptions = geometryFor("small", "ridiculous");
    expect(
      growthFor(
        DISPLAY.width - enormousOptions.maxReach + 1,
        DISPLAY,
        enormousOptions,
      ),
    ).toBe("right");
  });
});

describe("placing a larger companion", () => {
  const LARGE = geometryFor("large", "large");

  /**
   * One size on both axes, then the two mixes. The clamp binds on the creature,
   * which is the avatar axis's answer, so an enormous pill beside a small
   * creature must not hold that creature away from the edge, and an enormous
   * creature beside a small pill must be held by its own whole box.
   */
  const SIZED = [LARGE, BIG_CREATURE, BIG_OPTIONS];

  test("holds the avatar at the edges by its own box, not the canvas", () => {
    for (const geometry of SIZED) {
      const placed = placeCanvas({ x: 9000, y: 500 }, WORK_AREA, geometry);
      expect(centreOf(placed, geometry).x).toBe(
        WORK_AREA.x + WORK_AREA.width - geometry.avatarBox / 2,
      );
    }
  });

  test("still never asks for an origin above the work area", () => {
    for (const geometry of SIZED) {
      for (const y of [-9000, 0, 25, 100, 400]) {
        expect(
          placeCanvas({ x: 700, y }, WORK_AREA, geometry).origin.y,
        ).toBeGreaterThanOrEqual(WORK_AREA.y);
      }
    }
  });

  /**
   * The gap left at the top is the shadow's room, so it scales with everything
   * else. Bigger is a worse ceiling than `small` and still nothing like the
   * canvas half-height the bug was.
   */
  test("reaches the top, short by the near edge its own canvas asks for", () => {
    for (const geometry of SIZED) {
      const centre = centreOf(
        placeCanvas({ x: 700, y: -9000 }, WORK_AREA, geometry),
        geometry,
      );
      expect(centre.y).toBe(WORK_AREA.y + geometry.dropBelow);
      expect(centre.y).toBeLessThan(WORK_AREA.y + geometry.riseAbove);
    }
  });

  test("flips the card at its own threshold, not the small one", () => {
    expect(cardGrowthFor(WORK_AREA.y + LARGE.riseAbove, WORK_AREA, LARGE)).toBe(
      "up",
    );
    expect(
      cardGrowthFor(WORK_AREA.y + LARGE.riseAbove - 1, WORK_AREA, LARGE),
    ).toBe("down");
  });
});
