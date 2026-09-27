/**
 * Fluid hover, ported from Fluid Functionalism's `useFluidHover` and
 * `FluidHoverHighlight` (MIT, see NOTICE). One highlight per list: the item
 * nearest the pointer wins, and a single overlay springs to its rect. A
 * pointer in a gap between rows still lights a row, and the highlight glides
 * from row to row instead of blinking.
 */
import * as stylex from "@stylexjs/stylex";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef, useState, type PointerEvent, type RefObject } from "react";
import { spring } from "./springs.ts";
import { colors, durations } from "./tokens.stylex.ts";

export interface ItemRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

type Axis = "x" | "y";

/**
 * The item the pointer is inside, or else the one whose centre is nearest
 * along the axis; ties keep the first. The pointer and the rects share the
 * container's coordinate space. Empty slots are skipped.
 */
export function pickNearest(
  axis: Axis,
  pointer: { readonly x: number; readonly y: number },
  rects: ReadonlyArray<ItemRect | undefined>,
): number | null {
  const position = axis === "x" ? pointer.x : pointer.y;
  let nearest: number | null = null;
  let nearestDistance = Infinity;

  for (const [index, rect] of rects.entries()) {
    if (rect === undefined) continue;

    const start = axis === "x" ? rect.left : rect.top;
    const size = axis === "x" ? rect.width : rect.height;

    if (position >= start && position <= start + size) return index;

    const distance = Math.abs(position - (start + size / 2));

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = index;
    }
  }

  return nearest;
}

function relativeRect(item: Element, container: HTMLElement): ItemRect {
  const box = item.getBoundingClientRect();
  const origin = container.getBoundingClientRect();

  return {
    top: box.top - origin.top - container.clientTop + container.scrollTop,
    left: box.left - origin.left - container.clientLeft + container.scrollLeft,
    width: box.width,
    height: box.height,
  };
}

export interface FluidHover<C extends HTMLElement, K> {
  /** The list's positioned container: the highlight's offset parent. */
  readonly containerRef: RefObject<C | null>;
  /** A ref callback that registers the item under `key`. */
  readonly register: (key: K) => (element: HTMLElement | null) => void;
  /** The lit item and its rect, or null. */
  readonly active: { readonly key: K; readonly rect: ItemRect } | null;
  /** Lights an item (keyboard focus moved to it) or none. */
  readonly light: (key: K | null) => void;
  readonly handlers: {
    readonly onPointerMove: (event: PointerEvent) => void;
    readonly onPointerLeave: () => void;
  };
}

/** Items register under a key: a row's index, a tab's value. */
export function useFluidHover<C extends HTMLElement, K>(axis: Axis): FluidHover<C, K> {
  const containerRef = useRef<C>(null);
  const items = useRef(new Map<K, HTMLElement>());
  const [active, setActive] = useState<FluidHover<C, K>["active"]>(null);

  const register = useCallback(
    (key: K) => (element: HTMLElement | null) => {
      if (element === null) items.current.delete(key);
      else items.current.set(key, element);
    },
    [],
  );

  const light = useCallback((key: K | null) => {
    const container = containerRef.current;
    const item = key === null ? undefined : items.current.get(key);

    setActive(
      key === null || item === undefined || container === null
        ? null
        : { key, rect: relativeRect(item, container) },
    );
  }, []);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const container = containerRef.current;

      if (container === null) return;

      const box = container.getBoundingClientRect();

      const pointer = {
        x: event.clientX - box.left - container.clientLeft + container.scrollLeft,
        y: event.clientY - box.top - container.clientTop + container.scrollTop,
      };

      const entries = Array.from(items.current, ([key, item]) => ({
        key,
        rect: relativeRect(item, container),
      }));

      const index = pickNearest(
        axis,
        pointer,
        entries.map((entry) => entry.rect),
      );

      setActive(index === null ? null : (entries[index] ?? null));
    },
    [axis],
  );

  const onPointerLeave = useCallback(() => setActive(null), []);

  return { containerRef, register, active, light, handlers: { onPointerMove, onPointerLeave } };
}

const styles = stylex.create({
  highlight: {
    position: "absolute",
    top: 0,
    left: 0,
    pointerEvents: "none",
    backgroundColor: colors.hover,
    transitionProperty: "background-color",
    transitionDuration: durations.fast,
  },
  destructive: { backgroundColor: colors.destructiveSurface },
});

/**
 * The overlay: pinned to the container's corner and moved by transform, so
 * travel runs on the compositor. It fades in where it first lands and out
 * when nothing is lit. Over a destructive item it takes the red tint, and
 * fades back to neutral as it glides off it.
 */
export function FluidHighlight({
  rect,
  destructive = false,
  xstyle,
}: {
  readonly rect: ItemRect | null;
  readonly destructive?: boolean;
  readonly xstyle?: stylex.StyleXStyles;
}) {
  return (
    <AnimatePresence>
      {rect !== null && (
        <motion.div
          aria-hidden="true"
          data-highlight=""
          data-destructive={destructive ? "" : undefined}
          className={
            stylex.props(styles.highlight, destructive && styles.destructive, xstyle).className
          }
          initial={{
            opacity: 0,
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          }}
          animate={{
            opacity: 1,
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          }}
          exit={{ opacity: 0, transition: spring.fast.exit }}
          transition={{ ...spring.fast, opacity: { duration: 0.08 } }}
        />
      )}
    </AnimatePresence>
  );
}
