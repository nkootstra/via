/**
 * A conversation told as a story: a sentence that sums it up, then its turns
 * down a time spine, each at its clock time from the start and with how long
 * it took on the right. Turns that went fine one after another fold into one
 * line that opens on them; a turn with something to say (it failed, fell back,
 * was left, took retries or is in flight) gets a card, and failures in a row
 * that failed the same way share one. A stretch with nothing running and a
 * switch of model get a marker; a sub-agent's turns run as a thread of their
 * own. A card opens on its upstream attempts, and a turn whose request via
 * kept offers it. A turn in flight grows as the caller's clock ticks.
 */
import * as stylex from "@stylexjs/stylex";
import { VisuallyHidden } from "@via/ui";
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
import { createContext, use, useId, useState, type ReactNode } from "react";
import { attemptOutcomeNames, categoryNames, didNotServe } from "../lib/attempt.ts";
import { withoutPrefix } from "../lib/model-entries.ts";
import { useMask } from "../lib/privacy.ts";
import { providerName } from "../lib/provider-name.ts";
import { outcomeKind, outcomeKindNames, type OutcomeKind } from "../lib/request-outcome.ts";
import {
  clockOffset,
  failureOf,
  storyOf,
  storySummary,
  tookMs,
  unserved,
  waitedMs,
  type StoryItem,
  type StorySummary,
} from "../lib/story.ts";
import type { Timeline, TimelineAttempt, TimelineTurn } from "../lib/timeline.ts";
import {
  formatCount,
  formatDuration,
  formatMs,
  formatTokens,
  formatUsd,
} from "../lib/usage-format.ts";
import { ChevronRightIcon, DocumentIcon } from "./icons.tsx";

const STRIPE_PX = 10;

const drift = stylex.keyframes({
  from: { transform: "translateX(0)" },
  to: { transform: `translateX(${STRIPE_PX}px)` },
});

const breathe = stylex.keyframes({
  "0%": { opacity: 1 },
  "50%": { opacity: 0.35 },
  "100%": { opacity: 1 },
});

const styles = stylex.create({
  root: {
    containerType: "inline-size",
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    minWidth: 0,
  },
  headline: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: space.s3,
    rowGap: space.s1,
    margin: 0,
  },
  headlineMain: {
    fontSize: text.subtitle,
    color: colors.foreground,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    textWrap: "pretty",
  },
  headlineMeta: {
    fontSize: text.caption,
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  bad: { color: colors.destructive },
  list: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // An entry: its clock time, the spine, and what happened.
  entry: {
    display: "grid",
    alignItems: "start",
  },
  time: {
    paddingInlineEnd: space.s1,
    textAlign: "end",
    fontSize: "11px",
    lineHeight: "20px",
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  timeNested: {
    overflow: "hidden",
    paddingInlineEnd: { default: space.s1, "@container (max-width: 520px)": 0 },
  },
  spine: {
    position: "relative",
    alignSelf: "stretch",
    "::before": {
      content: '""',
      position: "absolute",
      top: 0,
      bottom: 0,
      left: "50%",
      width: "1px",
      backgroundColor: `color-mix(in oklab, ${colors.foreground} 14%, transparent)`,
    },
  },
  spineIdle: {
    "::before": {
      backgroundColor: "transparent",
      backgroundImage: `linear-gradient(to bottom, color-mix(in oklab, ${colors.foreground} 24%, transparent) 50%, transparent 50%)`,
      backgroundSize: "1px 5px",
    },
  },
  // The spine starts at the first entry's node, and ends at the last's.
  spineFirst: { "::before": { top: "8px" } },
  spineLast: { "::before": { bottom: "auto", height: "12px" } },
  spineOnly: { "::before": { display: "none" } },
  node: {
    position: "absolute",
    left: "50%",
    boxSizing: "border-box",
    width: "9px",
    height: "9px",
    marginLeft: "-4.5px",
    borderRadius: radii.full,
    borderWidth: "1.5px",
    borderStyle: "solid",
    borderColor: colors.chart1,
    backgroundColor: colors.surface3,
  },
  nodeSmall: {
    width: "5px",
    height: "5px",
    marginLeft: "-2.5px",
    borderWidth: 0,
    backgroundColor: colors.mutedForeground,
  },
  nodeSwitch: {
    borderRadius: "2px",
    transform: "rotate(45deg)",
    borderColor: colors.chart4,
  },
  nodeAgent: { borderColor: colors.chart6 },
  body: {
    minWidth: 0,
    paddingInlineStart: space.s2,
    paddingBottom: space.s2,
  },
  // A card: a turn with something to say, or failures in a row.
  card: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    padding: space.s3,
    borderRadius: "10px",
    backgroundColor: colors.surface2,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${colors.foreground} 9%, transparent)`,
  },
  cardFailed: {
    backgroundColor: `color-mix(in oklab, ${colors.destructive} 4%, ${colors.surface2})`,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${colors.destructive} 30%, transparent)`,
  },
  cardLive: {
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${colors.chart1} 45%, transparent)`,
  },
  // Its number, model and how long: the time goes to a line of its own when the model is long.
  head: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: space.s2,
    minWidth: 0,
  },
  // A folded turn's clock time, which a phone leaves out for its model's sake.
  foldedClock: { display: { default: null, "@container (max-width: 520px)": "none" } },
  turnNumber: {
    flexShrink: 0,
    fontSize: text.caption,
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  model: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: fonts.mono,
    fontSize: "12px",
    color: colors.foreground,
  },
  unknown: { fontFamily: "inherit", fontStyle: "italic" },
  took: {
    flexShrink: 0,
    marginInlineStart: "auto",
    paddingInlineStart: space.s2,
    fontSize: text.body,
    color: colors.foreground,
    fontVariantNumeric: "tabular-nums",
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    whiteSpace: "nowrap",
  },
  tookLive: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    color: colors.chart1,
  },
  note: {
    margin: 0,
    fontSize: text.caption,
    color: colors.warning,
    overflowWrap: "anywhere",
  },
  meter: {
    position: "relative",
    display: "flex",
    flexShrink: 0,
    height: "6px",
    overflow: "hidden",
    borderRadius: "3px",
    backgroundColor: `color-mix(in oklab, ${colors.foreground} 6%, transparent)`,
  },
  grow: { flexGrow: 1 },
  facts: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: space.s3,
    rowGap: space.s0_5,
    margin: 0,
    fontSize: text.caption,
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  // A turn in flight keeps to one line, so its card doesn't grow as its words change.
  factsLive: {
    flexWrap: "nowrap",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
  fact: { minWidth: 0, overflowWrap: "anywhere" },
  value: { color: colors.foreground },
  callout: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    paddingBlock: space.s2,
    paddingInline: space.s2_5,
    borderRadius: "6px",
    backgroundColor: `color-mix(in oklab, ${colors.destructive} 8%, transparent)`,
    fontSize: text.caption,
  },
  calloutTitle: {
    color: colors.destructive,
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
    overflowWrap: "anywhere",
  },
  calloutText: { color: colors.foreground, overflowWrap: "anywhere" },
  code: { fontFamily: fonts.mono, fontSize: "11px" },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s1,
    marginInlineStart: `calc(-1 * ${space.s1_5})`,
  },
  action: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    height: "26px",
    paddingInline: space.s1_5,
    borderWidth: 0,
    borderRadius: "6px",
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    fontFamily: "inherit",
    fontSize: text.caption,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
    cursor: "pointer",
    outline: "none",
    boxShadow: { default: null, ":focus-visible": `inset 0 0 0 2px ${colors.focusRing}` },
    whiteSpace: "nowrap",
  },
  actionMuted: { color: colors.mutedForeground },
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    transitionProperty: "transform",
    transitionDuration: durations.moderate,
    transitionTimingFunction: durations.pressEase,
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0s" },
  },
  chevronOpen: { transform: "rotate(90deg)" },
  stillTransition: { transitionDuration: "0s" },
  attempts: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    margin: 0,
    padding: 0,
    listStyle: "none",
    fontSize: text.caption,
  },
  attempt: {
    display: "grid",
    gridTemplateColumns: "1.5rem minmax(0, 1fr) auto",
    columnGap: space.s1,
    alignItems: "baseline",
    color: colors.mutedForeground,
  },
  attemptSeq: { fontVariantNumeric: "tabular-nums" },
  attemptRoute: { color: colors.foreground },
  attemptText: { minWidth: 0, overflowWrap: "anywhere" },
  attemptMessage: {
    display: "block",
    marginTop: space.s0_5,
    color: colors.foreground,
    overflowWrap: "anywhere",
  },
  attemptMs: {
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  // A turn on a line: its number, model, who served it, its bar and how long.
  line: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
    minHeight: "20px",
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  lineNumber: {
    flexShrink: 0,
    minWidth: "1.5rem",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  lineModel: {
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: fonts.mono,
    fontSize: "11.5px",
    color: colors.foreground,
  },
  served: {
    flexShrink: 2,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    "@container (max-width: 520px)": { display: "none" },
  },
  lineMeter: {
    width: { default: "64px", "@container (max-width: 520px)": "36px" },
    marginInlineStart: "auto",
  },
  lineTook: {
    flexShrink: 0,
    minWidth: "3.5rem",
    textAlign: "end",
    color: colors.foreground,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  // A run of turns, folded: the whole line opens it.
  fold: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    boxSizing: "border-box",
    width: `calc(100% + ${space.s2})`,
    minHeight: "28px",
    marginTop: "-4px",
    marginInlineStart: `calc(-1 * ${space.s2})`,
    paddingInlineStart: space.s2,
    paddingInlineEnd: 0,
    borderWidth: 0,
    borderRadius: "6px",
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    fontFamily: "inherit",
    fontSize: text.caption,
    color: colors.mutedForeground,
    textAlign: "start",
    cursor: "pointer",
    outline: "none",
    boxShadow: { default: null, ":focus-visible": `inset 0 0 0 2px ${colors.focusRing}` },
  },
  // What a fold holds: on a phone the model goes under its count, cut short.
  foldText: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: space.s1_5,
    minWidth: 0,
    paddingBlock: space.s1,
    lineHeight: 1.4,
  },
  foldCount: {
    color: colors.foreground,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    whiteSpace: "nowrap",
  },
  // On a phone the model goes under the count, which "all OK" then follows.
  foldDot: { display: { default: null, "@container (max-width: 520px)": "none" } },
  foldModel: {
    order: { default: null, "@container (max-width: 520px)": 1 },
    flexBasis: { default: null, "@container (max-width: 520px)": "100%" },
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: fonts.mono,
    fontSize: "11.5px",
  },
  nowrap: { whiteSpace: "nowrap" },
  rhythm: {
    display: "flex",
    flexShrink: 0,
    gap: "2px",
    width: { default: "112px", "@container (max-width: 520px)": "44px" },
    height: "6px",
    marginInlineStart: "auto",
  },
  beat: {
    display: "flex",
    minWidth: "2px",
    height: "100%",
    overflow: "hidden",
    borderRadius: "1.5px",
  },
  folded: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    margin: 0,
    paddingTop: space.s1,
    paddingInlineStart: "20px",
    listStyle: "none",
  },
  // A failure in a row of them: when it came, how long, and what to open.
  // When it came and how long it took, then what to open under them.
  failure: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: space.s2,
    rowGap: 0,
    fontSize: text.caption,
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  failureWhen: { minWidth: 0 },
  failureActions: { gridColumn: "1 / -1" },
  failureTook: {
    color: colors.foreground,
    whiteSpace: "nowrap",
  },
  failureRows: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  marker: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    minHeight: "24px",
    marginTop: "-2px",
    fontSize: "11.5px",
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  idle: { letterSpacing: "0.02em" },
  switch: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    minWidth: 0,
    maxWidth: "100%",
    paddingBlock: "2px",
    paddingInline: space.s2,
    borderRadius: radii.full,
    color: colors.chart4,
    backgroundColor: `color-mix(in oklab, ${colors.chart4} 10%, transparent)`,
  },
  switchWords: { flexShrink: 0, whiteSpace: "nowrap" },
  switchModel: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: fonts.mono,
    fontSize: "11px",
  },
  thread: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    paddingBlock: space.s1,
    paddingInlineStart: { default: space.s3, "@container (max-width: 520px)": space.s2 },
    borderInlineStart: `2px solid color-mix(in oklab, ${colors.chart6} 55%, transparent)`,
  },
  threadHead: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: space.s2,
    fontSize: text.caption,
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  threadName: {
    color: colors.foreground,
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
    overflowWrap: "anywhere",
  },
  empty: { margin: 0, fontSize: text.body, color: colors.mutedForeground },
  stripes: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: `-${STRIPE_PX}px`,
    right: 0,
    backgroundImage: `repeating-linear-gradient(-45deg, transparent 0 3.5px, color-mix(in oklab, ${colors.surface3} 40%, transparent) 3.5px 7.07px)`,
    backgroundSize: `${STRIPE_PX}px ${STRIPE_PX}px`,
    pointerEvents: "none",
    animationName: drift,
    animationDuration: "1.2s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
  dot: {
    display: "inline-block",
    flexShrink: 0,
    width: "6px",
    height: "6px",
    borderRadius: radii.full,
    backgroundColor: colors.chart1,
    boxShadow: `0 0 0 3px color-mix(in oklab, ${colors.chart1} 22%, transparent)`,
    animationName: breathe,
    animationDuration: "1.6s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
  // Still, for a viewer who set Motion to Reduced here rather than on their device.
  still: { animationName: "none" },
});

type Kind = OutcomeKind | "live";

const solid = stylex.create({
  ok: { backgroundColor: colors.chart1 },
  failed: { backgroundColor: colors.destructive },
  fellBack: { backgroundColor: colors.warning },
  aborted: { backgroundColor: colors.chartOther },
  live: { backgroundColor: colors.chart1 },
});

const tint = (color: string) => ({
  backgroundColor: `color-mix(in oklab, ${color} 30%, transparent)`,
});

const pale = stylex.create({
  ok: tint(colors.chart1),
  failed: tint(colors.destructive),
  fellBack: tint(colors.warning),
  aborted: tint(colors.chartOther),
  live: tint(colors.chart1),
});

const nodes = stylex.create({
  ok: {},
  failed: { borderColor: colors.destructive, backgroundColor: colors.destructive },
  fellBack: { borderColor: colors.warning },
  aborted: { borderColor: colors.chartOther },
  live: {
    borderColor: colors.chart1,
    backgroundColor: colors.chart1,
    boxShadow: `0 0 0 4px color-mix(in oklab, ${colors.chart1} 20%, transparent)`,
  },
});

const dynamic = stylex.create({
  columns: (clock: string) => ({ gridTemplateColumns: `${clock} 20px minmax(0, 1fr)` }),
  nestedColumns: (clock: string) => ({
    gridTemplateColumns: {
      default: `${clock} 20px minmax(0, 1fr)`,
      "@container (max-width: 520px)": "0 14px minmax(0, 1fr)",
    },
  }),
  width: (width: string) => ({ width }),
  grow: (grow: number) => ({ flexGrow: grow, flexBasis: 0 }),
  top: (top: string) => ({ top }),
  timeTop: (top: string) => ({ paddingTop: top }),
});

const percent = (share: number) => `${Math.min(Math.max(share, 0), 1) * 100}%`;

/** A model's name, without its provider's prefix, or that the request named none. */
const modelName = (model: string) => {
  const name = withoutPrefix(model);

  return name === "" ? "Unknown model" : name;
};

const kindOf = (row: TimelineTurn): Kind => (row.live ? "live" : outcomeKind(row.turn));

const turnsWord = (count: number) => `${formatCount(count)} ${count === 1 ? "turn" : "turns"}`;

/** Who answered a turn, or is answering it: the account of a pool, else the provider. */
const servedBy = (row: TimelineTurn, hide: (name: string) => string) => {
  const answerer = row.live ? row.attempts.at(-1)?.attempt : row.turn;

  if (answerer === undefined) return "";

  return Option.match(answerer.accountLabel, {
    onNone: () => providerName(answerer.provider),
    onSome: hide,
  });
};

/** What the rows need from around them: the clock, the kept requests and opening one. */
interface Setting {
  readonly from: number;
  readonly now: number;
  readonly clock: string;
  readonly captured: ReadonlySet<string>;
  readonly view: (requestId: string, number: number) => void;
}

const SettingContext = createContext<Setting>({
  from: 0,
  now: 0,
  clock: "3ch",
  captured: new Set(),
  view: () => {},
});

/** What the headline adds for the turns in flight: none, one and how it's going, or how many. */
const inFlightWords = ({ live, streaming }: StorySummary) => {
  if (live === 0) return "";

  if (live > 1) return `, ${formatCount(live)} still in flight`;

  return streaming === 1 ? ", one still streaming" : ", one still waiting for its first token";
};

/** Whether the entries are a sub-agent's: on a phone they leave their clock to its header. */
const NestedContext = createContext(false);

export function ConversationStory({
  timeline,
  now,
  captured = new Set(),
  onViewRequest = () => {},
}: {
  readonly timeline: Timeline;
  /** The time now, to which a turn in flight runs. */
  readonly now: number;
  /** The turns, by request id, whose request via kept. */
  readonly captured?: ReadonlySet<string>;
  /** Opens a turn's kept request. */
  readonly onViewRequest?: (requestId: string, number: number) => void;
}) {
  const summary = storySummary(timeline, now);

  if (summary.turns === 0) {
    return <p {...stylex.props(styles.empty)}>via kept none of this conversation's turns.</p>;
  }

  const items = storyOf(timeline.items, now);
  // The clock's column fits its longest time, which is the last.
  const longest = clockOffset(timeline.to - timeline.from).length;

  return (
    <div {...stylex.props(styles.root)}>
      <p {...stylex.props(styles.headline)}>
        <span {...stylex.props(styles.headlineMain)}>
          {turnsWord(summary.turns)} over {formatDuration(summary.spanMs)}
          {inFlightWords(summary)}
        </span>
        <span {...stylex.props(styles.headlineMeta)}>
          {formatDuration(summary.busyMs)} of model time · {formatCount(summary.models)}{" "}
          {summary.models === 1 ? "model" : "models"}
          {summary.failed > 0 && (
            <>
              {" · "}
              <span {...stylex.props(styles.bad)}>{formatCount(summary.failed)} failed</span>
            </>
          )}
        </span>
      </p>
      <SettingContext
        value={{
          from: timeline.from,
          now,
          clock: `${longest + 1}ch`,
          captured,
          view: onViewRequest,
        }}
      >
        <Entries items={items} label="Timeline" />
      </SettingContext>
    </div>
  );
}

function Entries({
  items,
  label,
}: {
  readonly items: ReadonlyArray<StoryItem>;
  readonly label: string;
}) {
  return (
    <ol aria-label={label} {...stylex.props(styles.list)}>
      {items.map((item, index) => (
        <Entry key={item.key} item={item} first={index === 0} last={index === items.length - 1} />
      ))}
    </ol>
  );
}

/** Where an entry's node sits, and its time with it, by what the entry is. */
const NODE_TOP = { line: "7.5px", card: "17px", marker: "8px", thread: "9px" } as const;

const TIME_TOP = { line: "0px", card: "8px", marker: "0px", thread: "1px" } as const;

function Row({
  time,
  at,
  node,
  idle = false,
  first,
  last,
  children,
}: {
  readonly time?: number | undefined;
  readonly at: keyof typeof NODE_TOP;
  readonly node?: stylex.StyleXStyles;
  readonly idle?: boolean;
  readonly first: boolean;
  readonly last: boolean;
  readonly children: ReactNode;
}) {
  const { from, clock } = use(SettingContext);
  const nested = use(NestedContext);
  const nodeTop = NODE_TOP[at];
  const timeTop = TIME_TOP[at];
  const alone = first && last;

  return (
    <li
      {...stylex.props(
        styles.entry,
        nested ? dynamic.nestedColumns(clock) : dynamic.columns(clock),
      )}
    >
      <span {...stylex.props(styles.time, nested && styles.timeNested, dynamic.timeTop(timeTop))}>
        {time === undefined ? "" : clockOffset(time - from)}
      </span>
      <span
        aria-hidden="true"
        {...stylex.props(
          styles.spine,
          idle && styles.spineIdle,
          first && styles.spineFirst,
          last && styles.spineLast,
          alone && styles.spineOnly,
        )}
      >
        {node !== undefined && <span {...stylex.props(styles.node, node, dynamic.top(nodeTop))} />}
      </span>
      <div {...stylex.props(styles.body)}>{children}</div>
    </li>
  );
}

function Entry({
  item,
  first,
  last,
}: {
  readonly item: StoryItem;
  readonly first: boolean;
  readonly last: boolean;
}) {
  const ends = { first, last };

  switch (item.kind) {
    case "idle":
      return (
        <Row at="marker" idle {...ends}>
          <span {...stylex.props(styles.marker, styles.idle)}>
            <span aria-hidden="true">·</span>
            <span>{formatDuration(item.ms)} idle</span>
            <span aria-hidden="true">·</span>
          </span>
        </Row>
      );
    case "switch":
      return (
        <Row at="marker" node={styles.nodeSwitch} {...ends}>
          <span {...stylex.props(styles.marker)}>
            <span title={`From ${item.from} to ${item.to}`} {...stylex.props(styles.switch)}>
              <span {...stylex.props(styles.switchWords)}>Switched to</span>
              <span {...stylex.props(styles.switchModel)}>{modelName(item.to)}</span>
            </span>
          </span>
        </Row>
      );
    case "turn":
      return item.card ? (
        <Row at="card" time={item.turn.turn.at} node={nodes[kindOf(item.turn)]} {...ends}>
          <TurnCard row={item.turn} />
        </Row>
      ) : (
        <Row at="line" time={item.turn.turn.at} node={styles.nodeSmall} {...ends}>
          <TurnLine row={item.turn} />
        </Row>
      );
    case "run":
      return (
        <Row at="line" time={item.turns[0]?.turn.at} node={styles.nodeSmall} {...ends}>
          <Run rows={item.turns} />
        </Row>
      );
    case "failures":
      return (
        <Row at="card" time={item.turns[0]?.turn.at} node={nodes.failed} {...ends}>
          <FailuresCard rows={item.turns} />
        </Row>
      );
    case "agent":
      return (
        <Row at="thread" time={item.from} node={styles.nodeAgent} {...ends}>
          <Thread item={item} />
        </Row>
      );
  }
}

function Thread({ item }: { readonly item: Extract<StoryItem, { kind: "agent" }> }) {
  const { from } = use(SettingContext);
  const name = Option.getOrElse(item.agent.agentType, () => "Sub-agent");

  return (
    <div {...stylex.props(styles.thread)}>
      <span title={item.agent.id} {...stylex.props(styles.threadHead)}>
        <span {...stylex.props(styles.threadName)}>{name}</span>
        <span>
          {turnsWord(item.turns)} · {formatDuration(item.to - item.from)} ·{" "}
          {clockOffset(item.from - from)}–{clockOffset(item.to - from)}
        </span>
      </span>
      <NestedContext value>
        <Entries
          items={item.items}
          label={Option.isSome(item.agent.agentType) ? `Sub-agent: ${name}` : "Sub-agent"}
        />
      </NestedContext>
    </div>
  );
}

/** A turn's bar: the share of its time it waited for its first token, pale, then streaming. */
function Bar({
  row,
  xstyle,
}: {
  readonly row: TimelineTurn;
  readonly xstyle?: stylex.StyleXStyles;
}) {
  const { now } = use(SettingContext);
  // Still when the viewer asked for less motion, here or on their device.
  const still = useReducedMotionConfig() === true;
  const kind = kindOf(row);
  const total = tookMs(row, now);

  // A turn that never had a token waited all along: in flight, or failed.
  const waited = Option.getOrElse(waitedMs(row), () => (row.live || kind === "failed" ? total : 0));

  return (
    <span aria-hidden="true" {...stylex.props(styles.meter, xstyle)}>
      <span {...stylex.props(pale[kind], dynamic.width(percent(total > 0 ? waited / total : 0)))} />
      <span {...stylex.props(styles.grow, solid[kind])} />
      {row.live && <span {...stylex.props(styles.stripes, still && styles.still)} />}
    </span>
  );
}

/** A disclosure's chevron: right while closed, down while open. */
function Chevron({ open }: { readonly open: boolean }) {
  // Still when the viewer asked for less motion, here or on their device.
  const still = useReducedMotionConfig() === true;

  return (
    <span
      aria-hidden="true"
      {...stylex.props(styles.chevron, open && styles.chevronOpen, still && styles.stillTransition)}
    >
      <ChevronRightIcon size={12} />
    </span>
  );
}

function LiveDot() {
  // Still when the viewer asked for less motion, here or on their device.
  const still = useReducedMotionConfig() === true;

  return <span aria-hidden="true" {...stylex.props(styles.dot, still && styles.still)} />;
}

function TurnLine({
  row,
  clock = false,
}: {
  readonly row: TimelineTurn;
  readonly clock?: boolean;
}) {
  const { from, now } = use(SettingContext);
  const mask = useMask();
  const unknown = withoutPrefix(row.turn.model) === "";

  return (
    <span {...stylex.props(styles.line)}>
      <span {...stylex.props(styles.lineNumber)}>
        <VisuallyHidden>Turn </VisuallyHidden>
        {row.number}
      </span>
      {clock && (
        <span {...stylex.props(styles.turnNumber, styles.foldedClock)}>
          {clockOffset(row.turn.at - from)}
        </span>
      )}
      <span title={row.turn.model} {...stylex.props(styles.lineModel, unknown && styles.unknown)}>
        {modelName(row.turn.model)}
      </span>
      <span {...stylex.props(styles.served)}>{servedBy(row, mask.key)}</span>
      <Bar row={row} xstyle={styles.lineMeter} />
      <span {...stylex.props(styles.lineTook)}>{formatDuration(tookMs(row, now))}</span>
    </span>
  );
}

function Run({ rows }: { readonly rows: ReadonlyArray<TimelineTurn> }) {
  const { now } = use(SettingContext);
  const [open, setOpen] = useState(false);
  const id = useId();
  const first = rows[0];
  const last = rows.at(-1);

  if (first === undefined || last === undefined) return null;

  const name = `Turns ${first.number}–${last.number}`;
  const total = rows.reduce((sum, row) => sum + tookMs(row, now), 0);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((was) => !was)}
        {...stylex.props(styles.fold)}
      >
        <Chevron open={open} />
        <span {...stylex.props(styles.foldText)}>
          <span {...stylex.props(styles.foldCount)}>{name}</span>
          <span aria-hidden="true" {...stylex.props(styles.foldDot)}>
            ·
          </span>
          <span {...stylex.props(styles.foldModel)}>{modelName(first.turn.model)}</span>
          <span {...stylex.props(styles.nowrap)}>· all OK</span>
        </span>
        <span aria-hidden="true" {...stylex.props(styles.rhythm)}>
          {rows.map((row) => {
            const took = tookMs(row, now);
            const waited = Option.getOrElse(waitedMs(row), () => 0);

            return (
              <span
                key={row.turn.requestId}
                {...stylex.props(styles.beat, dynamic.grow(Math.max(took, 1)))}
              >
                <span
                  {...stylex.props(pale.ok, dynamic.width(percent(took > 0 ? waited / took : 0)))}
                />
                <span {...stylex.props(styles.grow, solid.ok)} />
              </span>
            );
          })}
        </span>
        <span {...stylex.props(styles.lineTook)}>{formatDuration(total)}</span>
      </button>
      {open && (
        <ol id={id} aria-label={name} {...stylex.props(styles.folded)}>
          {rows.map((row) => (
            <li key={row.turn.requestId}>
              <TurnLine row={row} clock />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** A failed turn's failure: the status and why, the upstream's code, and its message. */
function FailureCallout({ row }: { readonly row: TimelineTurn }) {
  const mask = useMask();
  const failure = Option.getOrUndefined(failureOf(row));

  if (failure === undefined) return null;

  return (
    <div {...stylex.props(styles.callout)}>
      <span {...stylex.props(styles.calloutTitle)}>
        {Option.isSome(failure.status) && `${failure.status.value} · `}
        {failure.reason}
        {Option.isSome(failure.code) && (
          <>
            {" · "}
            <span {...stylex.props(styles.code)}>{failure.code.value}</span>
          </>
        )}
      </span>
      {Option.isSome(failure.message) && (
        <span {...stylex.props(styles.calloutText)}>{mask.key(failure.message.value)}</span>
      )}
    </div>
  );
}

/** What a kept turn's card says under its head: how its time went, its tokens, who served it. */
function Facts({ row }: { readonly row: Extract<TimelineTurn, { live: false }> }) {
  const mask = useMask();
  const { turn } = row;
  const kind = outcomeKind(turn);

  return (
    <p {...stylex.props(styles.facts)}>
      {kind === "failed" ? (
        <span>
          No answer · gave up after{" "}
          <span {...stylex.props(styles.value)}>{formatMs(turn.durationMs)}</span>
        </span>
      ) : (
        Option.isSome(turn.firstChunkMs) && (
          <span>
            Waited <span {...stylex.props(styles.value)}>{formatMs(turn.firstChunkMs.value)}</span>,
            streamed{" "}
            <span {...stylex.props(styles.value)}>
              {formatMs(Math.max(turn.durationMs - turn.firstChunkMs.value, 0))}
            </span>
            {kind === "aborted" && ", then the client left"}
          </span>
        )
      )}
      {Option.isSome(turn.inputTokens) && (
        <span>
          {formatTokens(turn.inputTokens.value)} in ·{" "}
          {formatTokens(Option.getOrElse(turn.outputTokens, () => 0))} out
        </span>
      )}
      <span {...stylex.props(styles.fact)}>{servedBy(row, mask.key)}</span>
      {Option.isSome(turn.costUsd) && <span>{formatUsd(turn.costUsd.value)} billed</span>}
    </p>
  );
}

/** The buttons under a turn: its attempts, opening beneath, and its kept request. */
function Actions({
  row,
  open,
  onToggle,
  attemptsId,
}: {
  readonly row: TimelineTurn;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly attemptsId: string;
}) {
  const { captured, view } = use(SettingContext);
  const count = row.attempts.length;
  const failures = unserved(row).length;
  const kept = !row.live && captured.has(row.turn.requestId);
  const flagged = count > 1 || failures > 0;

  if (count === 0 && !kept) return null;

  return (
    <div {...stylex.props(styles.actions)}>
      {count > 0 && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? attemptsId : undefined}
          aria-label={`Attempts of turn ${row.number}${flagged ? `: ${count}, ${failures} failed` : ""}`}
          onClick={onToggle}
          {...stylex.props(styles.action, styles.actionMuted)}
        >
          <Chevron open={open} />
          {formatCount(count)} {count === 1 ? "attempt" : "attempts"}
          {failures > 0 && (
            <span {...stylex.props(styles.bad)}>· {formatCount(failures)} failed</span>
          )}
        </button>
      )}
      {kept && (
        <button
          type="button"
          onClick={() => view(row.turn.requestId, row.number)}
          {...stylex.props(styles.action)}
        >
          <DocumentIcon size={13} />
          View request
        </button>
      )}
    </div>
  );
}

function TurnCard({ row }: { readonly row: TimelineTurn }) {
  const { now } = use(SettingContext);
  const [open, setOpen] = useState(false);
  const attemptsId = useId();
  const kind = kindOf(row);
  const took = tookMs(row, now);
  const unknown = withoutPrefix(row.turn.model) === "";
  const state = row.live ? "in flight" : outcomeKindNames[outcomeKind(row.turn)];

  return (
    <article
      aria-label={`Turn ${row.number}, ${modelName(row.turn.model)}, ${state}, ${formatDuration(took)}`}
      {...stylex.props(
        styles.card,
        kind === "failed" && styles.cardFailed,
        row.live && styles.cardLive,
      )}
    >
      <div {...stylex.props(styles.head)}>
        <span {...stylex.props(styles.turnNumber)}>Turn {row.number}</span>
        <span title={row.turn.model} {...stylex.props(styles.model, unknown && styles.unknown)}>
          {modelName(row.turn.model)}
        </span>
        <span {...stylex.props(styles.took, row.live && styles.tookLive)}>
          {row.live && <LiveDot />}
          {formatDuration(took)}
          {row.live && " so far"}
        </span>
      </div>
      {!row.live && Option.isSome(row.turn.requestedModel) && (
        <p title={row.turn.requestedModel.value} {...stylex.props(styles.note)}>
          Fell back from {withoutPrefix(row.turn.requestedModel.value)}
        </p>
      )}
      {kind !== "failed" && <Bar row={row} />}
      {row.live ? <LiveFacts row={row} /> : <Facts row={row} />}
      <FailureCallout row={row} />
      {row.live ? (
        row.attempts.length > 0 && <Attempts row={row} />
      ) : (
        <>
          <Actions
            row={row}
            open={open}
            onToggle={() => setOpen((was) => !was)}
            attemptsId={attemptsId}
          />
          {open && <Attempts row={row} id={attemptsId} />}
        </>
      )}
    </article>
  );
}

/** How a turn in flight is going: waiting for its first token, or streaming since. */
function LiveFacts({ row }: { readonly row: TimelineTurn }) {
  const waited = waitedMs(row);

  return (
    <p {...stylex.props(styles.facts, styles.factsLive)}>
      {Option.isSome(waited) ? (
        <span>
          Streaming · <span {...stylex.props(styles.value)}>{formatMs(waited.value)}</span> to first
          token
        </span>
      ) : (
        "Waiting for its first token"
      )}
    </p>
  );
}

function FailuresCard({ rows }: { readonly rows: ReadonlyArray<TimelineTurn> }) {
  const first = rows[0];
  const last = rows.at(-1);

  if (first === undefined || last === undefined) return null;

  const name = `Turns ${first.number}–${last.number}`;

  return (
    <article
      aria-label={`${name}, ${modelName(first.turn.model)}, ${rows.length} failed in a row`}
      {...stylex.props(styles.card, styles.cardFailed)}
    >
      <div {...stylex.props(styles.head)}>
        <span {...stylex.props(styles.turnNumber)}>{name}</span>
        <span title={first.turn.model} {...stylex.props(styles.model)}>
          {modelName(first.turn.model)}
        </span>
        <span {...stylex.props(styles.took, styles.bad)}>
          {formatCount(rows.length)} failed in a row
        </span>
      </div>
      <FailureCallout row={first} />
      <ol aria-label={`Failures of ${name.toLowerCase()}`} {...stylex.props(styles.failureRows)}>
        {rows.map((row) => (
          <FailureRow key={row.turn.requestId} row={row} />
        ))}
      </ol>
    </article>
  );
}

function FailureRow({ row }: { readonly row: TimelineTurn }) {
  const { from, now } = use(SettingContext);
  const [open, setOpen] = useState(false);
  const attemptsId = useId();

  return (
    <li>
      <div {...stylex.props(styles.failure)}>
        <span {...stylex.props(styles.failureWhen)}>
          Turn {row.number} · {clockOffset(row.turn.at - from)}
        </span>
        <span {...stylex.props(styles.failureTook)}>{formatDuration(tookMs(row, now))}</span>
        <div {...stylex.props(styles.failureActions)}>
          <Actions
            row={row}
            open={open}
            onToggle={() => setOpen((was) => !was)}
            attemptsId={attemptsId}
          />
        </div>
      </div>
      {open && <Attempts row={row} id={attemptsId} />}
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

function Attempts({ row, id }: { readonly row: TimelineTurn; readonly id?: string }) {
  return (
    <ol id={id} aria-label={`Attempts of turn ${row.number}`} {...stylex.props(styles.attempts)}>
      {row.attempts.map((placed) => (
        <Attempt key={placed.attempt.seq} placed={placed} />
      ))}
    </ol>
  );
}

/** An attempt: where it went, the account and model, its status, how it ended and why. */
function Attempt({ placed }: { readonly placed: TimelineAttempt }) {
  const { now } = use(SettingContext);
  const mask = useMask();
  const { attempt } = placed;

  const said = [
    ...Option.match(attempt.accountLabel, {
      onNone: () => [],
      onSome: (label) => [mask.key(label)],
    }),
    modelName(attempt.model),
    ...Option.match(attempt.status, { onNone: () => [], onSome: (status) => [`HTTP ${status}`] }),
  ];

  const failedHere = !placed.open && didNotServe(placed.attempt);

  const ended = placed.open
    ? "In flight"
    : Option.match(placed.attempt.category, {
        onNone: () => attemptOutcomeNames[placed.attempt.outcome],
        onSome: (category) => categoryNames[category],
      });

  return (
    <li {...stylex.props(styles.attempt)}>
      <span {...stylex.props(styles.attemptSeq)}>{attempt.seq + 1}.</span>
      <span {...stylex.props(styles.attemptText)}>
        <span {...stylex.props(styles.attemptRoute)}>{routeOf(placed)}</span>
        {" · "}
        {said.join(" · ")}
        {" · "}
        <span
          title={placed.open ? undefined : Option.getOrUndefined(placed.attempt.category)}
          {...stylex.props(failedHere && styles.bad)}
        >
          {ended}
        </span>
        {!placed.open && Option.isSome(placed.attempt.upstreamCode) && (
          <>
            {" · "}
            <span {...stylex.props(styles.code)}>{placed.attempt.upstreamCode.value}</span>
          </>
        )}
        {!placed.open && Option.isSome(placed.attempt.message) && (
          <span {...stylex.props(styles.attemptMessage)}>
            {mask.key(placed.attempt.message.value)}
          </span>
        )}
      </span>
      <span {...stylex.props(styles.attemptMs)}>
        {formatDuration(
          placed.open ? Math.max(now - attempt.startedAt, 0) : placed.attempt.durationMs,
        )}
      </span>
    </li>
  );
}
