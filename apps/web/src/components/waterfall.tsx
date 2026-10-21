/**
 * A conversation's waterfall: one row per turn on a shared time axis, its bar
 * from when it came in to when it ended, pale while it waited for its first
 * token and solid while it streamed, coloured by how it ended, and how long it
 * took beside it. A sub-agent's turns sit on rows nested under the
 * conversation that started it, on a band that spans its time. The bars are
 * one stop for Tab, and the arrow keys move between them; each shows its
 * turn's detail on hover or focus. A long conversation scrolls under its axis.
 *
 * A turn's upstream attempts open beneath it, on the same axis, each with why
 * it didn't serve; a turn that took more than one, or had one fail, says so.
 * A turn in flight runs to now and grows as the page's clock ticks; the clock
 * is the caller's, which ticks less often for a viewer who asks for less motion.
 */
import * as stylex from "@stylexjs/stylex";
import { Tooltip } from "@via/ui";
import {
  colors,
  durations,
  fonts,
  fontWeights,
  radii,
  space,
  text,
  weights,
} from "@via/ui/tokens.stylex";
import { Option } from "effect";
import { useReducedMotionConfig } from "motion/react";
import {
  createContext,
  use,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { attemptOutcomeNames, categoryNames, didNotServe } from "../lib/attempt.ts";
import {
  LABEL_GAP_PX,
  MIN_TICK_GAP_PX,
  axisStep,
  axisTicks,
  formatTicks,
  labelPlacement,
} from "../lib/axis.ts";
import { withoutPrefix } from "../lib/model-entries.ts";
import { useMask } from "../lib/privacy.ts";
import { providerName } from "../lib/provider-name.ts";
import {
  outcomeDetail,
  outcomeKind,
  outcomeKindNames,
  outcomeOf,
  type OutcomeKind,
} from "../lib/request-outcome.ts";
import type {
  Timeline,
  TimelineAgent,
  TimelineAttempt,
  TimelineItem,
  TimelineTurn,
} from "../lib/timeline.ts";
import { formatDuration, formatMs, formatTokens, formatUsd } from "../lib/usage-format.ts";
import { ChevronRightIcon } from "./icons.tsx";

/** Below this width, in pixels, a row stacks its label over its track, which keeps the axis readable. */
const STACKED_PX = 480;

// The stripes of a bar in flight: one tile, moved along by its own width.
const STRIPE_PX = 12;

const drift = stylex.keyframes({
  from: { transform: "translateX(0)" },
  to: { transform: `translateX(${STRIPE_PX}px)` },
});

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    minWidth: 0,
  },
  legend: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: space.s4,
    rowGap: space.s1,
    margin: 0,
    padding: 0,
    listStyle: "none",
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  legendItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
  },
  swatch: {
    position: "relative",
    overflow: "hidden",
    width: "14px",
    height: "8px",
    borderRadius: "2px",
  },
  // The rows, under their axis: a long conversation scrolls here, not the page.
  scroller: {
    maxHeight: "min(36rem, 70vh)",
    overflowY: "auto",
    overscrollBehavior: "contain",
    // The axis stays over the rows; a bar brought into view by the keys clears it.
    scrollPaddingTop: "32px",
    // Room for a bar's focus ring at the track's end.
    paddingInlineEnd: space.s1,
    paddingBottom: space.s1,
  },
  // A row: its label, then its track, the axis's width; stacked when narrow.
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(0, clamp(8.5rem, 30%, 17rem)) minmax(0, 1fr)",
    alignItems: "center",
    columnGap: space.s3,
    minHeight: "28px",
    borderRadius: "6px",
    backgroundColor: { default: null, ":hover": colors.hover },
  },
  axis: {
    position: "sticky",
    top: 0,
    zIndex: 2,
    minHeight: "24px",
    borderRadius: 0,
    backgroundColor: { default: colors.surface3, ":hover": colors.surface3 },
    borderBottom: `1px solid ${colors.border}`,
    marginBottom: space.s1,
    fontSize: text.caption,
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  // Stacked, a row is its label over its track, each the full width.
  stacked: { gridTemplateColumns: "minmax(0, 1fr)" },
  // …and has no label column to keep clear on the axis, nor a track for a sub-agent's header.
  gone: { display: "none" },
  ticks: {
    position: "relative",
    alignSelf: "stretch",
  },
  tick: {
    position: "absolute",
    top: "50%",
    whiteSpace: "nowrap",
    transform: "translate(-50%, -50%)",
  },
  tickStart: { transform: "translateY(-50%)" },
  tickEnd: { transform: "translate(-100%, -50%)" },
  now: { color: colors.foreground },
  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  label: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    minWidth: 0,
    minHeight: "24px",
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  // A turn's label that opens its attempts: the whole label is the button.
  toggle: {
    width: "100%",
    paddingBlock: 0,
    paddingInlineEnd: space.s1,
    borderWidth: 0,
    borderRadius: "6px",
    backgroundColor: "transparent",
    fontFamily: "inherit",
    textAlign: "start",
    cursor: "pointer",
    outline: "none",
    boxShadow: {
      default: null,
      ":focus-visible": `inset 0 0 0 2px ${colors.focusRing}`,
    },
  },
  labelText: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  number: {
    flexShrink: 0,
    minWidth: "3ch",
    textAlign: "end",
    fontVariantNumeric: "tabular-nums",
  },
  model: {
    fontFamily: fonts.mono,
    color: colors.foreground,
  },
  unknown: { fontStyle: "italic" },
  agent: {
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
  },
  // A sub-agent's name keeps its room; how many turns and how long give way first.
  agentName: { flexShrink: 0, maxWidth: "70%" },
  agentMeta: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    width: "14px",
    transform: "rotate(0deg)",
    transitionProperty: "transform",
    transitionDuration: durations.moderate,
    transitionTimingFunction: durations.pressEase,
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0s" },
  },
  chevronOpen: { transform: "rotate(90deg)" },
  // Where a turn without attempts would have its chevron, so the numbers line up.
  chevronSpace: {
    flexShrink: 0,
    width: "14px",
  },
  // What a turn's attempts came to, at the end of its label.
  flag: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    flexShrink: 0,
    marginInlineStart: "auto",
    paddingInlineStart: space.s1_5,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  flagFailed: { color: colors.destructive },
  dot: {
    width: "6px",
    height: "6px",
    borderRadius: radii.full,
    backgroundColor: colors.destructive,
  },
  track: {
    position: "relative",
    height: "28px",
    // The axis's steps, faintly, behind the bars.
    backgroundImage: `linear-gradient(to right, color-mix(in oklab, ${colors.border} 70%, transparent) 1px, transparent 1px)`,
    backgroundRepeat: "repeat-x",
  },
  bar: {
    position: "absolute",
    top: "7px",
    display: "flex",
    height: "14px",
    minWidth: "3px",
    overflow: "hidden",
    borderRadius: "4px",
  },
  // A turn's bar is a button: it shows the turn's detail.
  barButton: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    cursor: "default",
    outline: "none",
    transitionProperty: "box-shadow",
    transitionDuration: durations.fast,
    transitionTimingFunction: "ease-out",
    boxShadow: {
      default: null,
      ":hover": `0 0 0 2px ${colors.surface3}, 0 0 0 3px ${colors.borderStrong}`,
      ":focus-visible": `0 0 0 2px ${colors.surface3}, 0 0 0 4px ${colors.focusRing}`,
    },
  },
  // An attempt's bar: thinner than its turn's.
  attemptBar: {
    top: "9px",
    height: "10px",
    borderRadius: "3px",
  },
  // A bar's two parts: waiting for the first token, then streaming.
  waiting: { flexShrink: 0, height: "100%" },
  streaming: { flexGrow: 1, height: "100%" },
  // A bar in flight: calm stripes drifting along it, still for less motion.
  stripes: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: `-${STRIPE_PX}px`,
    right: 0,
    backgroundImage: `repeating-linear-gradient(-45deg, transparent 0 4.243px, color-mix(in oklab, ${colors.surface3} 38%, transparent) 4.243px 8.485px)`,
    backgroundSize: `${STRIPE_PX}px ${STRIPE_PX}px`,
    pointerEvents: "none",
    animationName: drift,
    animationDuration: "1.4s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
  // Still, for a viewer who set Motion to Reduced here rather than on their device.
  still: { animationName: "none" },
  // …and on a bar still waiting, in its own colour, so they show on the pale.
  stripesPale: {
    backgroundImage: `repeating-linear-gradient(-45deg, transparent 0 4.243px, color-mix(in oklab, ${colors.chart1} 30%, transparent) 4.243px 8.485px)`,
  },
  // How long a bar took, beside it.
  duration: {
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    fontSize: "11px",
    lineHeight: 1,
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  },
  // A bar that fills its track carries its label on a chip, inside its end.
  durationInside: {
    paddingBlock: "2px",
    paddingInline: space.s1,
    borderRadius: "3px",
    backgroundColor: colors.surface3,
    color: colors.foreground,
  },
  // A sub-agent: a band behind its rows, across its time.
  group: { position: "relative" },
  bandLayer: {
    position: "absolute",
    inset: 0,
    display: "grid",
    gridTemplateColumns: "minmax(0, clamp(8.5rem, 30%, 17rem)) minmax(0, 1fr)",
    columnGap: space.s3,
    pointerEvents: "none",
  },
  bandColumn: {
    position: "relative",
    gridColumn: "2",
  },
  band: {
    position: "absolute",
    top: "2px",
    bottom: "2px",
    minWidth: "4px",
    borderRadius: "6px",
    backgroundColor: `color-mix(in oklab, ${colors.foreground} 3%, transparent)`,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${colors.foreground} 9%, transparent)`,
  },
  attempts: {
    paddingBlock: space.s1,
  },
  attemptRoute: {
    minWidth: 0,
    overflowWrap: "anywhere",
    lineHeight: 1.3,
  },
  // What an attempt was and why it ended, under its bar.
  attemptDetail: {
    gridColumn: "2",
    margin: 0,
    paddingBottom: space.s1_5,
    fontSize: text.caption,
    color: colors.mutedForeground,
    overflowWrap: "break-word",
  },
  attemptDetailStacked: { gridColumn: "1" },
  // An upstream code: one identifier, on one line, cut short when it must be.
  code: {
    display: "inline-block",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    verticalAlign: "bottom",
    fontFamily: fonts.mono,
  },
  attemptFailed: { color: colors.destructive },
  message: {
    display: "block",
    marginTop: space.s0_5,
    color: colors.foreground,
    overflowWrap: "anywhere",
  },
  detail: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: space.s3,
    rowGap: space.s0_5,
    margin: 0,
  },
  entry: { display: "contents" },
  detailTitle: {
    display: "block",
    marginBottom: space.s1,
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
  },
  term: { color: colors.mutedForeground },
  value: { margin: 0, fontVariantNumeric: "tabular-nums" },
});

/**
 * Each way a turn ended, in its colour, solid while it streamed; the same in
 * light and dark, as the chart's are. One in flight is the colour of OK.
 */
const solid = stylex.create({
  ok: { backgroundColor: colors.chart1 },
  failed: { backgroundColor: colors.destructive },
  fellBack: { backgroundColor: colors.warning },
  aborted: { backgroundColor: colors.chartOther },
  live: { backgroundColor: colors.chart1 },
});

/**
 * The same colours, pale, while a turn waited for its first token; outlined in
 * the solid colour, so the bar stands out from the track all the same.
 */
const tint = (color: string) => ({
  backgroundColor: `color-mix(in oklab, ${color} 22%, transparent)`,
  boxShadow: `inset 0 0 0 1px ${color}`,
});

const pale = stylex.create({
  ok: tint(colors.chart1),
  failed: tint(colors.destructive),
  fellBack: tint(colors.warning),
  aborted: tint(colors.chartOther),
  live: tint(colors.chart1),
  // The legend's: waiting, whatever the outcome.
  any: tint(colors.mutedForeground),
});

/** Where a bar lies on its track, and what share of it went to waiting. */
const position = stylex.create({
  place: (left: string, width: string) => ({ left, width }),
  waiting: (width: string) => ({ width }),
  after: (left: string) => ({ left }),
  before: (right: string) => ({ right }),
  grid: (size: string) => ({ backgroundSize: size }),
  tick: (left: string) => ({ left }),
});

type BarKind = OutcomeKind | "live";

const KINDS: ReadonlyArray<OutcomeKind> = ["ok", "failed", "fellBack", "aborted"];

const kindNames: Readonly<Record<BarKind, string>> = { ...outcomeKindNames, live: "In flight" };

/** Each level of nesting indents its labels this much more. */
const INDENT_PX = 12;

/** A turn's chevron and the gap after it: its attempts' labels start past it, under its number. */
const CHEVRON_PX = 20;

/** How wide a track is taken to be until it's measured, as on a laptop. */
const DEFAULT_TRACK_PX = 640;

const percent = (share: number) => `${share * 100}%`;

/** An offset from the conversation's start: "0 s", "+12 s", "+4.5 min", "+1.2 h". */
const formatOffset = (ms: number) => (ms <= 0 ? "0 s" : `+${formatDuration(ms)}`);

/** A model's name, or that the request named none. */
const modelName = (model: string) => {
  const name = withoutPrefix(model);

  return name === "" ? "Unknown model" : name;
};

/** The turns in the order their rows are drawn: down the page, into each sub-agent's. */
const flatten = (items: ReadonlyArray<TimelineItem>): ReadonlyArray<TimelineTurn> =>
  items.flatMap((item) => (item.kind === "turn" ? [item] : flatten(item.items)));

/**
 * The roving focus the bars share: which bar takes Tab, each bar's element,
 * and the keys that move focus from one bar to the next.
 */
interface Bars {
  readonly current: string | undefined;
  readonly register: (id: string) => (element: HTMLButtonElement | null) => void;
  readonly focused: (id: string) => void;
  readonly move: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

const BarsContext = createContext<Bars>({
  current: undefined,
  register: () => () => {},
  focused: () => {},
  move: () => {},
});

/** The axis as the rows draw it: the conversation, its track's width, and its step as a share. */
interface Axis {
  readonly timeline: Timeline;
  readonly width: number;
  readonly grid: number;
  readonly stacked: boolean;
}

const AxisContext = createContext<Axis>({
  timeline: { from: 0, to: 1, items: [] },
  width: DEFAULT_TRACK_PX,
  grid: 1,
  stacked: false,
});

/** The width of the element `ref` comes to hold, as it changes; undefined until measured. */
function useWidth<E extends HTMLElement>() {
  const ref = useRef<E>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const element = ref.current;

    // A page without layout, such as a test's, keeps the default.
    if (element === null || !("ResizeObserver" in globalThis)) return;

    const measure = () => {
      const measured = element.getBoundingClientRect().width;

      if (measured > 0) setWidth(measured);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

export function Waterfall({ timeline }: { readonly timeline: Timeline }) {
  const rows = flatten(timeline.items);
  const order = rows.map((row) => row.turn.requestId);
  const elements = useRef(new Map<string, HTMLButtonElement>());
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const [rootRef, rootWidth] = useWidth<HTMLDivElement>();
  const [trackRef, measured] = useWidth<HTMLSpanElement>();
  const width = measured ?? DEFAULT_TRACK_PX;
  const stacked = rootWidth !== undefined && rootWidth < STACKED_PX;
  const span = timeline.to - timeline.from;
  const live = rows.some((row) => row.live);
  const step = axisStep(span, width);

  // While a turn is in flight the axis ends at now, which takes the last tick's place.
  const ticks = axisTicks(span, width).filter(
    (tick) => !live || tick === 0 || ((span - tick) / span) * width >= MIN_TICK_GAP_PX,
  );

  const labels = formatTicks(ticks, step);
  const waiting = rows.some((row) => Option.isSome(row.firstChunk));
  const shown = current !== undefined && order.includes(current) ? current : order[0];

  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const at = order.indexOf(shown ?? "");

    const next = {
      ArrowDown: at + 1,
      ArrowRight: at + 1,
      ArrowUp: at - 1,
      ArrowLeft: at - 1,
      Home: 0,
      End: order.length - 1,
    }[event.key];

    if (next === undefined) return;

    event.preventDefault();
    const id = order[Math.min(Math.max(next, 0), order.length - 1)];

    if (id === undefined) return;
    setCurrent(id);
    elements.current.get(id)?.focus();
  };

  const bars: Bars = {
    current: shown,
    register: (id) => (element) => {
      if (element === null) elements.current.delete(id);
      else elements.current.set(id, element);
    },
    focused: setCurrent,
    move,
  };

  // A label this close to the track's end is set against it, not centred on its tick.
  const nearEnd = (tick: number) => ((span - tick) / span) * width < MIN_TICK_GAP_PX / 2;

  return (
    <div ref={rootRef} {...stylex.props(styles.root)}>
      <ul aria-label="Legend" {...stylex.props(styles.legend)}>
        {KINDS.map((kind) => (
          <li key={kind} {...stylex.props(styles.legendItem)}>
            <span aria-hidden="true" {...stylex.props(styles.swatch, solid[kind])} />
            {kindNames[kind]}
          </li>
        ))}
        {live && (
          <li {...stylex.props(styles.legendItem)}>
            <span aria-hidden="true" {...stylex.props(styles.swatch, solid.live)}>
              <span {...stylex.props(styles.stripes)} />
            </span>
            {kindNames.live}
          </li>
        )}
        {waiting && (
          <li {...stylex.props(styles.legendItem)}>
            <span aria-hidden="true" {...stylex.props(styles.swatch, pale.any)} />
            Waiting for first token
          </li>
        )}
      </ul>
      <div {...stylex.props(styles.scroller)}>
        <div
          aria-hidden="true"
          data-testid="axis"
          {...stylex.props(styles.row, styles.axis, stacked && styles.stacked)}
        >
          <span {...stylex.props(stacked && styles.gone)} />
          <span ref={trackRef} {...stylex.props(styles.ticks)}>
            {ticks.map((tick, index) => (
              <span
                key={tick}
                {...stylex.props(
                  styles.tick,
                  position.tick(percent(tick / span)),
                  tick === 0 && styles.tickStart,
                  tick !== 0 && nearEnd(tick) && styles.tickEnd,
                )}
              >
                {labels[index]}
              </span>
            ))}
            {live && (
              <span
                {...stylex.props(styles.tick, position.tick("100%"), styles.tickEnd, styles.now)}
              >
                now
              </span>
            )}
          </span>
        </div>
        <AxisContext value={{ timeline, width, grid: step / span, stacked }}>
          <BarsContext value={bars}>
            <ol aria-label="Timeline" {...stylex.props(styles.list)}>
              <Items items={timeline.items} depth={0} />
            </ol>
          </BarsContext>
        </AxisContext>
      </div>
    </div>
  );
}

function Items({
  items,
  depth,
}: {
  readonly items: ReadonlyArray<TimelineItem>;
  readonly depth: number;
}) {
  return items.map((item, index) => {
    if (item.kind === "agent") return <AgentRows key={item.id} agent={item} depth={depth} />;

    const above = items[index - 1];

    return (
      <TurnRow
        key={item.turn.requestId}
        row={item}
        depth={depth}
        // A model the row above already names goes without saying.
        repeated={above?.kind === "turn" && above.turn.model === item.turn.model}
      />
    );
  });
}

/** What a sub-agent is called: its type when its client said, else a plain "Sub-agent". */
const agentName = (agent: TimelineAgent) => Option.getOrElse(agent.agentType, () => "Sub-agent");

/** A track, its axis's steps faintly behind it. */
function Track({
  hidden = false,
  header = false,
  children,
}: {
  readonly hidden?: boolean;
  readonly header?: boolean;
  readonly children?: ReactNode;
}) {
  const { grid, stacked } = use(AxisContext);

  return (
    <span
      aria-hidden={hidden ? "true" : undefined}
      {...stylex.props(
        styles.track,
        position.grid(`${percent(grid)} 100%`),
        header && stacked && styles.gone,
      )}
    >
      {children}
    </span>
  );
}

function AgentRows({ agent, depth }: { readonly agent: TimelineAgent; readonly depth: number }) {
  const { timeline, stacked } = use(AxisContext);
  const turns = flatten(agent.items);
  const start = Math.min(...turns.map((row) => row.start));
  const end = Math.max(...turns.map((row) => row.end));
  const name = agentName(agent);
  const took = (end - start) * (timeline.to - timeline.from);

  return (
    <li {...stylex.props(styles.group)}>
      {/* Stacked, a band would cross the labels: the header and the indent carry the group. */}
      {!stacked && (
        <span aria-hidden="true" {...stylex.props(styles.bandLayer)}>
          <span {...stylex.props(styles.bandColumn)}>
            <span
              {...stylex.props(styles.band, position.place(percent(start), percent(end - start)))}
            />
          </span>
        </span>
      )}
      <div {...stylex.props(styles.row, stacked && styles.stacked)}>
        <span
          title={agent.id}
          style={{ paddingInlineStart: depth * INDENT_PX }}
          {...stylex.props(styles.label)}
        >
          <span aria-hidden="true" {...stylex.props(styles.chevronSpace)} />
          <span {...stylex.props(styles.labelText, styles.agent, styles.agentName)}>{name}</span>
          <span {...stylex.props(styles.agentMeta)}>
            {turns.length} {turns.length === 1 ? "turn" : "turns"} · {formatDuration(took)}
          </span>
        </span>
        <Track hidden header />
      </div>
      <ol
        aria-label={Option.isSome(agent.agentType) ? `Sub-agent: ${name}` : "Sub-agent"}
        {...stylex.props(styles.list)}
      >
        <Items items={agent.items} depth={depth + 1} />
      </ol>
    </li>
  );
}

/** How a turn's bar is coloured: how it ended, or in flight. */
const kindOf = (row: TimelineTurn): BarKind => (row.live ? "live" : outcomeKind(row.turn));

/** How long a turn took, or, in flight, has taken so far. */
const durationOf = (row: TimelineTurn, timeline: Timeline) =>
  row.live ? timeline.to - row.turn.at : row.turn.durationMs;

/** A turn's bar's name: everything its tooltip shows at a glance, for assistive tech. */
const barName = (row: TimelineTurn, timeline: Timeline) =>
  [
    `Turn ${row.number}`,
    modelName(row.turn.model),
    kindNames[kindOf(row)],
    `${formatMs(durationOf(row, timeline))}${row.live ? " so far" : ""}`,
    `at ${formatOffset(row.turn.at - timeline.from)}`,
  ].join(", ");

/** The attempts of a turn that didn't serve, which ended. */
const unserved = (row: TimelineTurn) =>
  row.attempts.filter((placed) => !placed.open && didNotServe(placed.attempt)).length;

/** A bar's left edge: where it starts, kept on its track even when it took no time at the end. */
const leftOf = (start: number) => `min(${percent(start)}, calc(100% - 3px))`;

/**
 * The share of a bar spent waiting for its first token: all of one in flight
 * that has none yet, and none of one that ended without.
 */
const waitedShare = (
  place: {
    readonly start: number;
    readonly end: number;
    readonly firstChunk: Option.Option<number>;
  },
  inFlight: boolean,
) =>
  Option.match(place.firstChunk, {
    onNone: () => (inFlight ? 1 : 0),
    onSome: (at) =>
      place.end > place.start
        ? Math.min(Math.max((at - place.start) / (place.end - place.start), 0), 1)
        : 0,
  });

/** A bar's fill: pale while it waited, solid while it streamed, striped in flight. */
function Fill({ kind, waited }: { readonly kind: BarKind; readonly waited: number }) {
  const still = useReducedMotionConfig() === true;

  return (
    <>
      {waited > 0 && (
        <span {...stylex.props(styles.waiting, pale[kind], position.waiting(percent(waited)))} />
      )}
      <span {...stylex.props(styles.streaming, solid[kind])} />
      {kind === "live" && (
        <span
          {...stylex.props(
            styles.stripes,
            waited >= 1 && styles.stripesPale,
            still && styles.still,
          )}
        />
      )}
    </>
  );
}

/** How long a bar took, after it, before it when there's no room after, or inside it. */
function Took({
  place,
  label,
}: {
  readonly place: { readonly start: number; readonly end: number };
  readonly label: string;
}) {
  const { width } = use(AxisContext);
  const where = labelPlacement(place, width, label);
  const end = Math.min(place.end, 1);

  return (
    <span
      aria-hidden="true"
      {...stylex.props(
        styles.duration,
        where === "after" && position.after(`calc(${percent(end)} + ${LABEL_GAP_PX}px)`),
        where === "before" &&
          position.before(`calc(${percent(1 - place.start)} + ${LABEL_GAP_PX}px)`),
        where === "inside" && position.before(`calc(${percent(1 - end)} + 4px)`),
        where === "inside" && styles.durationInside,
      )}
    >
      {label}
    </span>
  );
}

/** What a turn's attempts came to, in words: how many failed, or how many it took. */
function AttemptsFlag({ count, failures }: { readonly count: number; readonly failures: number }) {
  if (failures > 0) {
    return (
      <span {...stylex.props(styles.flag, styles.flagFailed)}>
        <span {...stylex.props(styles.dot)} />
        {failures} failed
      </span>
    );
  }

  return count > 1 ? <span {...stylex.props(styles.flag)}>{count} attempts</span> : null;
}

/**
 * A turn's row: its number and model, opening its attempts when it has them,
 * then its bar; and, opened, its upstream attempts beneath, on the same axis.
 */
function TurnRow({
  row,
  depth,
  repeated,
}: {
  readonly row: TimelineTurn;
  readonly depth: number;
  readonly repeated: boolean;
}) {
  const { current, register, focused, move } = use(BarsContext);
  const { timeline, stacked } = use(AxisContext);
  const [opened, setOpened] = useState(false);
  const attemptsId = useId();
  const id = row.turn.requestId;
  const count = row.attempts.length;
  const failures = unserved(row);
  const flagged = count > 1 || failures > 0;
  const model = modelName(row.turn.model);
  const unknown = withoutPrefix(row.turn.model) === "";

  const inner = (
    <>
      {count === 0 ? (
        <span aria-hidden="true" {...stylex.props(styles.chevronSpace)} />
      ) : (
        <span aria-hidden="true" {...stylex.props(styles.chevron, opened && styles.chevronOpen)}>
          <ChevronRightIcon size={14} />
        </span>
      )}
      <span aria-hidden="true" {...stylex.props(styles.number)}>
        {row.number}
      </span>
      {(!repeated || unknown) && (
        <span
          {...stylex.props(styles.labelText, !unknown && styles.model, unknown && styles.unknown)}
        >
          {model}
        </span>
      )}
      <AttemptsFlag count={count} failures={failures} />
    </>
  );

  return (
    <li>
      <div {...stylex.props(styles.row, stacked && styles.stacked)}>
        {count === 0 ? (
          <span
            title={row.turn.model}
            style={{ paddingInlineStart: depth * INDENT_PX }}
            {...stylex.props(styles.label)}
          >
            {inner}
          </span>
        ) : (
          <button
            type="button"
            aria-expanded={opened}
            aria-controls={opened ? attemptsId : undefined}
            aria-label={`Attempts of turn ${row.number}${flagged ? `: ${count}, ${failures} failed` : ""}`}
            title={`${row.turn.model}: ${count} ${count === 1 ? "attempt" : "attempts"}, ${failures} failed`}
            onClick={() => setOpened((was) => !was)}
            style={{ paddingInlineStart: depth * INDENT_PX }}
            {...stylex.props(styles.label, styles.toggle)}
          >
            {inner}
          </button>
        )}
        <Track>
          <Tooltip content={<TurnDetail row={row} timeline={timeline} />}>
            <button
              type="button"
              ref={register(id)}
              tabIndex={current === id ? 0 : -1}
              aria-label={barName(row, timeline)}
              onFocus={() => focused(id)}
              onKeyDown={move}
              {...stylex.props(
                styles.bar,
                styles.barButton,
                position.place(leftOf(row.start), percent(row.end - row.start)),
              )}
            >
              <Fill kind={kindOf(row)} waited={waitedShare(row, row.live)} />
            </button>
          </Tooltip>
          <Took place={row} label={formatDuration(durationOf(row, timeline))} />
        </Track>
      </div>
      {opened && count > 0 && (
        <ol
          id={attemptsId}
          aria-label={`Attempts of turn ${row.number}`}
          {...stylex.props(styles.list, styles.attempts)}
        >
          {row.attempts.map((placed) => (
            <AttemptRow key={placed.attempt.seq} placed={placed} depth={depth} />
          ))}
        </ol>
      )}
    </li>
  );
}

/** Where an attempt went: its provider, and on to which one when a router says. */
const routeOf = (placed: TimelineAttempt) =>
  placed.open
    ? providerName(placed.attempt.provider)
    : Option.match(placed.attempt.downstreamProvider, {
        onNone: () => providerName(placed.attempt.provider),
        onSome: (downstream) => `${providerName(placed.attempt.provider)} → ${downstream}`,
      });

/** How an attempt's bar is coloured: as it ended, or in flight. */
const attemptKind = (placed: TimelineAttempt): BarKind =>
  placed.open ? "live" : didNotServe(placed.attempt) ? "failed" : "ok";

/** How long an attempt took, or, under way, has taken so far. */
const attemptTook = (placed: TimelineAttempt, timeline: Timeline) =>
  placed.open ? timeline.to - placed.attempt.startedAt : placed.attempt.durationMs;

/** What an attempt was and how it ended: its account, model, status, why and code. */
function AttemptRow({
  placed,
  depth,
}: {
  readonly placed: TimelineAttempt;
  readonly depth: number;
}) {
  const mask = useMask();
  const { timeline, stacked } = use(AxisContext);
  const { attempt } = placed;
  const route = routeOf(placed);

  const said = [
    ...Option.match(attempt.accountLabel, {
      onNone: () => [],
      onSome: (label) => [mask.key(label)],
    }),
    modelName(attempt.model),
    ...Option.match(attempt.status, { onNone: () => [], onSome: (status) => [`HTTP ${status}`] }),
  ];

  const ended = placed.open
    ? kindNames.live
    : Option.match(placed.attempt.category, {
        onNone: () => attemptOutcomeNames[placed.attempt.outcome],
        onSome: (category) => categoryNames[category],
      });

  return (
    <li>
      <div {...stylex.props(styles.row, stacked && styles.stacked)}>
        <span
          title={route}
          style={{ paddingInlineStart: depth * INDENT_PX + CHEVRON_PX }}
          {...stylex.props(styles.label)}
        >
          <span aria-hidden="true" {...stylex.props(styles.number)}>
            {attempt.seq + 1}.
          </span>
          <span {...stylex.props(styles.attemptRoute)}>{route}</span>
        </span>
        <Track hidden>
          <span
            {...stylex.props(
              styles.bar,
              styles.attemptBar,
              position.place(leftOf(placed.start), percent(placed.end - placed.start)),
            )}
          >
            <Fill kind={attemptKind(placed)} waited={waitedShare(placed, placed.open)} />
          </span>
          <Took place={placed} label={formatDuration(attemptTook(placed, timeline))} />
        </Track>
        <p {...stylex.props(styles.attemptDetail, stacked && styles.attemptDetailStacked)}>
          {said.join(" · ")} ·{" "}
          <span
            title={placed.open ? undefined : Option.getOrUndefined(placed.attempt.category)}
            {...stylex.props(!placed.open && didNotServe(placed.attempt) && styles.attemptFailed)}
          >
            {ended}
          </span>
          {!placed.open && Option.isSome(placed.attempt.upstreamCode) && (
            <>
              {" · "}
              <span title={placed.attempt.upstreamCode.value} {...stylex.props(styles.code)}>
                {placed.attempt.upstreamCode.value}
              </span>
            </>
          )}
          {!placed.open && Option.isSome(placed.attempt.message) && (
            <span {...stylex.props(styles.message)}>{mask.key(placed.attempt.message.value)}</span>
          )}
        </p>
      </div>
    </li>
  );
}

/** Who answered a turn: the provider, and the account when one of a pool's did. */
const servedBy = (
  turn: { readonly provider: string; readonly accountLabel: Option.Option<string> },
  hide: (name: string) => string,
) =>
  Option.match(turn.accountLabel, {
    onNone: () => providerName(turn.provider),
    onSome: (label) => `${providerName(turn.provider)} · ${hide(label)}`,
  });

/** A turn's tokens: what it sent, of it cached, and what came back. */
const tokensDetail = (turn: Extract<TimelineTurn, { live: false }>["turn"]) =>
  Option.match(turn.inputTokens, {
    onNone: () => "None reported",
    onSome: (input) =>
      [
        `${formatTokens(input)} in`,
        ...Option.match(turn.cachedTokens, {
          onNone: () => [],
          onSome: (cached) => (cached > 0 ? [`${formatTokens(cached)} cached`] : []),
        }),
        `${formatTokens(Option.getOrElse(turn.outputTokens, () => 0))} out`,
      ].join(" · "),
  });

type Entries = ReadonlyArray<readonly [string, string]>;

/** What a turn in flight shows: who it is with now, how long so far, and its first token. */
const liveEntries = (
  row: Extract<TimelineTurn, { live: true }>,
  timeline: Timeline,
  hide: (name: string) => string,
): Entries => {
  const now = row.attempts.at(-1);

  return [
    ...(now === undefined ? [] : ([["With", servedBy(now.attempt, hide)]] as const)),
    ["So far", formatMs(durationOf(row, timeline))],
    ...(row.attempts.length > 1 ? ([["Attempts", String(row.attempts.length)]] as const) : []),
    ...Option.match(
      Option.flatMap(Option.fromNullishOr(now), (placed) => placed.attempt.firstChunkMs),
      {
        onNone: () => [],
        onSome: (ms): Entries => [["First token", formatMs(ms)]],
      },
    ),
  ];
};

function TurnDetail({
  row,
  timeline,
}: {
  readonly row: TimelineTurn;
  readonly timeline: Timeline;
}) {
  const mask = useMask();

  const entries: Entries = row.live
    ? liveEntries(row, timeline, mask.key)
    : [
        ...Option.match(row.turn.requestedModel, {
          onNone: () => [],
          onSome: (asked): Entries => [["Fallback", `Fell back from ${withoutPrefix(asked)}`]],
        }),
        ["Served by", servedBy(row.turn, mask.key)],
        ["Tokens", tokensDetail(row.turn)],
        ...Option.match(row.turn.costUsd, {
          onNone: () => [],
          onSome: (usd): Entries => [["Billed", formatUsd(usd)]],
        }),
        ["Duration", formatMs(row.turn.durationMs)],
        ...Option.match(row.turn.firstChunkMs, {
          onNone: () => [],
          onSome: (ms): Entries => [["First token", formatMs(ms)]],
        }),
        ["Outcome", `${outcomeOf(row.turn)} (${outcomeDetail(row.turn)})`],
        ...Option.match(row.turn.errorMessage, {
          onNone: () => [],
          onSome: (message): Entries => [["Why", mask.key(message)]],
        }),
      ];

  return (
    <>
      <span {...stylex.props(styles.detailTitle)}>
        Turn {row.number} · {modelName(row.turn.model)}
        {row.live ? " · In flight" : ""}
      </span>
      <dl {...stylex.props(styles.detail)}>
        {entries.map(([term, value]) => (
          <div key={term} {...stylex.props(styles.entry)}>
            <dt {...stylex.props(styles.term)}>{term}</dt>
            <dd {...stylex.props(styles.value)}>{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
