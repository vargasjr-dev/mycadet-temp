import { type DragEvent, type ReactNode, type Ref } from "react";
import type { LucideIcon } from "lucide-react";

import { BottomSheet, ContextMenu, SideMenu } from "@mycadet/design-library";
import { cn } from "@mycadet/design-library/utils/cn";

import {
  SIDEBAR_CHIP_GAP_CLASSES,
  SIDEBAR_HEADER_PADDING_X,
  SIDEBAR_MOBILE_CHIP_CLASSES,
  SIDEBAR_MOBILE_GLYPH_CLASSES,
  SIDEBAR_ROW_PADDING_X,
  SIDEBAR_SECTION_CONTENT_PADDING_TOP,
  SIDEBAR_SECTION_INDENT,
  SIDEBAR_SECTION_TITLE_GAP,
  SIDEBAR_SECTION_TITLE_TEXT_CLASSES,
} from "@/components/sidebar-nav-geometry";
import { useLongPressSheet } from "@/hooks/use-long-press-sheet";
import { useTranslation } from "@/i18n";
import { isPointerCoarse } from "@/utils/pointer";

/**
 * A sidebar section: a header row (glyph, label, trailing "…") over its
 * content, optionally drawn on a card. Sections do not fold — there is no
 * chevron and no toggle; the list is always fully visible.
 *
 *   - Leading icon, at every state. `sectionIcon` is the single answer to
 *     "what does this section look like", so a header and its collapsed-rail
 *     tile show the same glyph; omit `icon` only for a section that has
 *     none.
 *   - The title row is the one toggle target: a click
 *     expands or collapses the section, while click-and-hold-and-move
 *     still drags it (see `drag`): HTML5 drag only starts on movement,
 *     so the two coexist on one surface. The chevron on the trailing
 *     edge, left of the "…", is a decorative indicator that forwards its
 *     clicks to that trigger, revealed only on hover, not on
 *     click-then-release focus, which would otherwise linger after the
 *     click that opened/closed it, and not just because the section is
 *     open.
 *   - Optional `trailing` slot for an ellipsis menu or other per-row
 *     affordance. Pointer events are isolated so clicking trailing
 *     content doesn't toggle the section.
 *   - Optional header menu, in two surfaces: `contextMenuContent`
 *     (desktop right-click) and `touchMenuContent` (touch long-press →
 *     bottom sheet). Supply both so the actions are reachable on every
 *     pointer type — Radix `ContextMenu` alone renders a pointer-positioned
 *     popover on touch, which is the wrong surface on mobile. Mirrors the
 *     conversation-row long-press pattern.
 *   - No hover background on the title; the chevron's own hover box is
 *     the affordance.
 *
 * Usage:
 *
 *   <CollapsibleNavSection.Root type="multiple" defaultValue={["scheduled"]}>
 *     <CollapsibleNavSection.Section
 *       value="scheduled"
 *       icon={Clock}
 *       label="Scheduled"
 *       trailing={<MenuButton />}
 *     >
 *       {childRows}
 *     </CollapsibleNavSection.Section>
 *   </CollapsibleNavSection.Root>
 */

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

function CollapsibleNavSectionRoot({
  className,
  ref,
  ...props
}: React.ComponentProps<"div"> & { ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      /* The mount point the sidebar body and the tests read: the same slot
         the accordion root it replaced carried, so the stack contract
         (flex fill on the body's chain, the shared gap) survives the
         accordion's removal. */
      data-slot="collapsible"
      className={cn("gap-2 flex flex-col", className)}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
// Touch header menu
// ---------------------------------------------------------------------------

/** The trailing "…" control owns its own taps, so it never arms the gesture. */
const skipTrailingControl = (target: Element | null) =>
  Boolean(target?.closest('[data-slot="collapsible-nav-section-trailing"]'));

/**
 * Wraps a section header so a long-press opens its actions in a bottom sheet.
 * The sheet is a sibling of the gesture wrapper, not a child — see
 * {@link useLongPressSheet}.
 */
function LongPressHeaderMenu({
  title,
  content,
  children,
}: {
  title: string;
  content: (close: () => void) => ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const longPress = useLongPressSheet({ shouldSkip: skipTrailingControl });

  return (
    <>
      <div {...longPress.wrapperProps}>{children}</div>
      <BottomSheet.Root
        open={longPress.open}
        onOpenChange={longPress.onOpenChange}
      >
        <BottomSheet.Content aria-describedby={undefined}>
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>
              {t("collapsibleNavSection.actionsTitle", { title })}
            </BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">
            {content(longPress.close)}
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    </>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

/**
 * Drag-to-reorder wiring for a whole section.
 *
 * Every handler goes on the **header** - it is both the drag handle and the
 * drop target - while the visual state (`dragging`, `dropEdge`) styles the
 * whole section box.
 *
 * The header, not the section root, owns the handlers deliberately.
 * `dragleave` bubbles, so a section root that is also the drop target
 * receives leave events from each of its own conversation rows as the pointer
 * crosses them; those have a `relatedTarget` outside the root, so the drop
 * indicator gets cleared on the way past an expanded section. Keeping the
 * handlers on one flat element (the same shape a conversation row uses)
 * removes that class of bug: leaves between the header's own children always
 * resolve to a descendant and are correctly ignored.
 *
 * Structural on purpose - this component sits in shared `components/` and
 * shouldn't reach into the chat domain's drag hook for a type.
 */
export interface CollapsibleNavSectionDrag {
  headerProps: {
    draggable: true;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
  /** True while this section is the one being dragged. */
  dragging: boolean;
  /** Edge to draw the insertion line on while hovered, else null. */
  dropEdge: "before" | "after" | null;
}

interface CollapsibleNavSectionSectionProps {
  icon?: LucideIcon;
  /**
   * Leading glyph for sections whose mark is not a Lucide icon. Takes the
   * same slot as {@link icon} (same box, same axis) and wins when both are
   * given, so a section states its glyph once whichever kind it is.
   *
   * Sized by the caller: the slot hugs its content rather than scaling it.
   */
  iconNode?: ReactNode;
  label: string;
  /**
   * Extra classes for the label span - a section that inks its title
   * differently states that here. The span keeps its structural classes
   * (`min-w-0 flex-1 truncate`) either way, so a styled label still fills the
   * row and still truncates.
   */
  labelClassName?: string;
  /**
   * Extra classes for the whole header row - for a section that draws its
   * header on its own surface. The title's horizontal geometry is inline
   * style from `sidebar-nav-geometry`, so a header surface that needs
   * different insets overrides them with `!` utilities against the title
   * slot.
   */
  headerClassName?: string;
  trailing?: ReactNode;
  contextMenuContent?: ReactNode;
  /**
   * Touch equivalent of `contextMenuContent` — rendered as the body of a
   * long-press bottom sheet. Receives a `close` callback so rows can dismiss
   * the sheet after running their action.
   */
  touchMenuContent?: (close: () => void) => ReactNode;
  /**
   * Holds the header's trailing controls painted regardless of hover, for the
   * moment a section has something to say about them (a row leaving for the
   * destination the "View all chats" icon names). The shared reveal rules own
   * the condition; this states it.
   */
  revealHold?: boolean;
  /** Drag-to-reorder wiring; omit to leave the section fixed in place. */
  drag?: CollapsibleNavSectionDrag;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
  ref?: Ref<HTMLDivElement>;
  /**
   * Draw the section as a self-contained card rather than a run of rows on
   * the panel's own surface. The card owns the horizontal inset, so the
   * header and the list inside it sit flush and the header shrinks to a bare
   * label row. The caller supplies the surface and radius through
   * `className`; this governs the geometry that has to agree with it.
   */
  card?: boolean;
  /**
   * Skips the "grow to fill the sidebar's remaining space while open" sizing
   * below. Pinned wants this: it grows to fit its own rows instead, and
   * should never stretch to claim space its rows don't use.
   */
  unbounded?: boolean;
  /**
   * Whether this is the bottom-most section in the list - only it grows to
   * fill leftover space while open; every section above it (even open, even
   * busy) sizes to its own content instead, since flex-grow would otherwise
   * hand every open section a share of the leftover space whether or not it
   * has enough rows to use it.
   */
  isLast?: boolean;
}

function CollapsibleNavSectionSection({
  icon: Icon,
  iconNode,
  label,
  labelClassName,
  headerClassName,
  trailing,
  contextMenuContent,
  touchMenuContent,
  revealHold = false,
  drag,
  children,
  className,
  contentClassName,
  ref,
  unbounded = false,
  isLast = false,
  card = false,
  ...itemProps
}: CollapsibleNavSectionSectionProps) {
  /* One slot for both header branches. The collapsible and non-collapsible
     headers show the same glyph on the same axis, so they read it from here
     rather than each rendering their own copy. */
  /* 14px on a pointer viewport, the size every pill's leading icon is drawn
     at there (Figma 8300:167416); on a phone the 16px those icons grow to,
     so a header's glyph carries the same weight as the pinned app's above
     it at either breakpoint. */
  const glyph =
    iconNode ??
    (Icon ? (
      <Icon size={14} aria-hidden className={SIDEBAR_MOBILE_GLYPH_CLASSES} />
    ) : null);
  const iconSlot = glyph ? (
    <span
      data-slot="collapsible-nav-section-icon"
      /* A chip-width box with the glyph centred in it padded the icon away
         from both edges, so the header read as indented from the row surfaces
         below it. Centring is the collapsed rail's need, and the rail draws
         its own tiles. */
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center",
        /* Only the Lucide branch takes the 14px box and the tertiary ink: a
           Lucide glyph draws in `currentColor` at a known size. A custom node
           carries its own colour and its own geometry (the assistant
           section's accent disc is a full row-height circle), so the slot
           hugs it instead of boxing it. On a phone the box is the chip the
           assistant row keeps its eyes in, so the glyph centres on the axis
           the eyes do. */
        !iconNode && "h-[14px] w-[14px] text-[var(--content-tertiary)]",
        !iconNode && SIDEBAR_MOBILE_CHIP_CLASSES,
      )}
    >
      {glyph}
    </span>
  ) : null;

  /* Both header branches are the same row: one is a disclosure trigger and
     the other is inert, so the geometry and the content are declared once and
     the branch below chooses only the element. */
  /* A card supplies the section's own inset, so the header sits flush
     inside it as a bare row with no vertical padding of its own. Its title
     takes the smaller of the two sizes on a wide viewport, and on a touch
     viewport the same large body size the pills above it (the assistant
     row, a pinned app) set their labels in, so a card's title stands at the
     same size as every other entry in the drawer rather than reading as a
     caption beneath them. */
  const titleClasses = cn(
    card ? "py-0" : "py-[6px] max-md:py-3",
    SIDEBAR_CHIP_GAP_CLASSES,
    SIDEBAR_SECTION_TITLE_TEXT_CLASSES,
    /* `!` twice over: the shared title classes pin their own weight the same
       way, so a plain utility here loses to them rather than replacing them. */
    card &&
      "text-body-small-default max-md:text-body-large-default font-[500]!",
  );

  /* The rail header leads at a pill's inset so its glyph and label line up
     with the pills above it; its trailing inset stays the row's. */
  const titleStyle = {
    paddingLeft: card ? 0 : SIDEBAR_HEADER_PADDING_X,
    paddingRight: card ? 0 : SIDEBAR_ROW_PADDING_X,
  };

  const titleContent = (
    <>
      {iconSlot}
      <span className={cn("min-w-0 flex-1 truncate", labelClassName)}>
        {label}
      </span>
    </>
  );

  const headerEl = (
    <div
      data-slot="collapsible-nav-section-header"
      /* The hover scope for the trailing "…": hovering anywhere on the header
         reveals it. Attribute-keyed rather than a Tailwind group, so the
         trigger's own unnamed `group` (the icon/chevron swap) cannot answer to
         it and this cannot answer to the trigger's. */
      data-reveal-row=""
      data-reveal-hold={revealHold ? "" : undefined}
      className={cn(
        "flex shrink-0 items-center justify-between",
        // The title trigger's Accordion.Header wrapper must grow to fill
        // the row, so the whole header (minus the trailing cluster) is
        // the click target and long labels still truncate. The primitive
        // hardcodes `flex` on it, so the growth comes from here.
        "[&>[data-slot=collapsible-header]]:min-w-0 [&>[data-slot=collapsible-header]]:flex-1",
        /* A card's header row, sized so that with the card's 12px vertical
           inset the collapsed pill lands on the overlay tile size (44px).
           The controls beside it are touch targets rather than content, so
           they keep their own size and centre-overflow this row instead of
           setting it; the card's top padding is deeper than the overflow,
           so nothing escapes the card. */
        card && "h-5",
        drag && "cursor-grab active:cursor-grabbing",
        headerClassName,
      )}
      {...drag?.headerProps}
    >
      {/* The horizontal geometry (padding, chip width, gap) is inline from
          sidebar-nav-geometry at every breakpoint — the assistant cluster
          shares it, so section icons and labels sit on the same axes as
          the assistant eyes. Only the vertical
          metrics grow on mobile. */}
      {/* No chevron, no toggle affordance: sections do not fold. Just the
          icon slot (if given) and the label, always at rest. Half the usual
          mobile bottom padding: the gap to the first row below reads as too
          large at the full py-3. */}
      <SideMenu.SectionHeader
        className={cn(titleClasses, "max-md:pt-3 max-md:pb-1.5")}
        style={titleStyle}
      >
        {titleContent}
      </SideMenu.SectionHeader>
      {trailing ? (
        /* No inset of its own on a phone: the card's 12px right padding
           puts the trailing "…"'s right edge where the pinned-app pill
           above sets its unpin glyph, so the two right edges are one line
           down the drawer. */
        <span className="flex shrink-0 items-center gap-1 pr-[6px] max-md:pr-0">
          <span
            data-slot="collapsible-nav-section-trailing"
            /* `empty:hidden` so a trailing component that renders nothing
               doesn't leave a padded box behind. */
            data-reveal=""
            className="flex items-center shrink-0 empty:hidden"
            onClick={(event) => event.stopPropagation()}
          >
            {trailing}
          </span>
        </span>
      ) : null}
    </div>
  );

  // Touch devices replace the right-click ContextMenu with a long-press sheet.
  // The gesture state lives in a child component so its hooks mount only on
  // the surfaces that use them.
  const header =
    isPointerCoarse() && touchMenuContent ? (
      <LongPressHeaderMenu title={label} content={touchMenuContent}>
        {headerEl}
      </LongPressHeaderMenu>
    ) : contextMenuContent ? (
      <ContextMenu.Root>
        <ContextMenu.Trigger>{headerEl}</ContextMenu.Trigger>
        <ContextMenu.Content onClick={(event) => event.stopPropagation()}>
          {contextMenuContent}
        </ContextMenu.Content>
      </ContextMenu.Root>
    ) : (
      headerEl
    );

  return (
    <div
      ref={ref}
      data-slot="collapsible-nav-section-section"
      /* Drag feedback draws the insertion line on the whole section box,
         rather than on the header strip, so "lands after this section"
         never reads as "lands inside it". */
      className={cn(
        // Only the bottom-most section takes the space the sidebar has
        // left. It hugs its rows and shrinks under that space (`min-h-0`
        // is what lets a flex item shrink below its content's natural
        // size), so a short or previewed list is a short card, not a card
        // the height of the rail with empty surface under its rows. It
        // grows (`flex-1`) only around a windowed row list, which needs a
        // definite height to know what to render. Every other section
        // sizes to its own content: flex-grow has no notion of "this
        // section needs the room," so giving every section a share
        // stretched a two-row group into a mostly-empty box the same size
        // as a busy one beside it.
        !unbounded &&
          isLast &&
          "min-h-0 flex flex-col has-[[data-slot=conversation-list-windowed]]:flex-1",
        drag?.dragging && "opacity-50",
        // Insertion line, matching the conversation-row drop indicator.
        drag?.dropEdge === "before" &&
          "shadow-[inset_0_2px_0_0_var(--primary-base)]",
        drag?.dropEdge === "after" &&
          "shadow-[inset_0_-2px_0_0_var(--primary-base)]",
        className,
      )}
      {...itemProps}
    >
      {header}
      {/*
       * The card carries no padding of its own (the header row above is
       * already a self-contained pill), so the content picks up the same
       * 12px horizontal inset directly, plus the card's bottom edge below.
       * Defined here rather than at each call site so no section can nest
       * differently from the rest.
       *
       * The top inset is the one part that is not the same number in both
       * branches, and deliberately so: it is whatever is left of
       * {@link SIDEBAR_SECTION_TITLE_GAP} after the header row above has
       * spent its own surplus height on the same gap, so a title stands the
       * same distance from its first row whichever surface draws it. See
       * that constant for why the gap is measured from the title's text.
       */}
      <div
        className={cn(
          "sidebar-section-list",
          card ? "[&_[data-slot=side-menu-sub-list]]:gap-0" : "pb-2",
          contentClassName,
        )}
        style={{
          paddingLeft: card
            ? 0
            : SIDEBAR_ROW_PADDING_X + SIDEBAR_SECTION_INDENT,
          paddingRight: card ? 0 : SIDEBAR_ROW_PADDING_X,
          paddingTop: card
            ? SIDEBAR_SECTION_TITLE_GAP
            : SIDEBAR_SECTION_CONTENT_PADDING_TOP,
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------

export const CollapsibleNavSection = {
  Root: CollapsibleNavSectionRoot,
  Section: CollapsibleNavSectionSection,
};
