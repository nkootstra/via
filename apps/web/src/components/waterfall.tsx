/**
 * A conversation's waterfall: one row per turn on a shared time axis, its bar
 * from when it came in to when it ended, a tick where its first chunk came,
 * coloured by how it ended. A sub-agent's turns sit on rows nested under the
 * conversation that started it. The bars are one stop for Tab, and the arrow
 * keys move between them; each shows its turn's detail on hover or focus.
 *
 * A turn's upstream attempts open beneath it, on the same axis, each with why
 * it didn't serve; a turn that took more than one, or had one fail, is flagged.
 * A turn in flight runs to now and grows as the page's clock ticks; the clock
 * is the caller's, which ticks less often for a viewer who asks for less motion.
 */
import * as stylex from "@stylexjs/stylex";
import { Tooltip } from "@via/ui";
import { colors, fonts, radii, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { Option } from "effect";
import { createContext, use, useId, useRef, useState, type KeyboardEvent } from "react";
import { attemptOutcomeNames, categoryNames, didNotServe } from "../lib/attempt.ts";
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
    gap: space.s3,
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
    width: "10px",
    height: "10px",
    borderRadius: "3px",
  },
  // The first chunk's tick, as the legend shows it.
  swatchTick: {
    width: "2px",
    height: "12px",
    backgroundColor: colors.foreground,
  },
  // A row: its label, then its track, the axis's width.
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(96px, 28%) 1fr",
    alignItems: "center",
    columnGap: space.s3,
    minHeight: "24px",
  },
  axis: {
    fontSize: text.caption,
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  ticks: {
    position: "relative",
    height: "16px",
  },
  tick: {
    position: "absolute",
    top: 0,
    whiteSpace: "nowrap",
    transform: "translateX(-50%)",
  },
  tickStart: { transform: "none" },
  tickEnd: { transform: "translateX(-100%)" },
  // A phone has room for the start, middle and end of the axis only.
  tickQuarter: { display: { default: "block", "@media (max-width: 640px)": "none" } },
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
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  labelText: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  number: {
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  },
  model: {
    fontFamily: fonts.mono,
    color: colors.foreground,
  },
  agent: {
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
  },
  // Opens a turn's attempts: a chevron, and how many when they're worth a look.
  toggle: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s0_5,
    minWidth: "20px",
    height: "20px",
    paddingBlock: 0,
    paddingInline: space.s0_5,
    borderWidth: 0,
    borderRadius: radii.item,
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    color: colors.mutedForeground,
    fontSize: text.caption,
    fontVariantNumeric: "tabular-nums",
    cursor: "pointer",
    outline: "none",
    boxShadow: {
      default: null,
      ":focus-visible": `0 0 0 2px ${colors.focusRing}`,
    },
  },
  // Where a turn without attempts would have its toggle, so the numbers line up.
  toggleSpace: {
    flexShrink: 0,
    width: "20px",
  },
  chevron: {
    display: "inline-flex",
    transform: "rotate(0deg)",
  },
  chevronOpen: { transform: "rotate(90deg)" },
  // A turn that took more than one attempt: their count.
  retried: {
    paddingInline: space.s1,
    borderRadius: radii.full,
    backgroundColor: colors.accent,
    color: colors.foreground,
  },
  // A turn one of whose attempts didn't serve.
  troubled: {
    backgroundColor: colors.warningSubtle,
  },
  track: {
    position: "relative",
    height: "24px",
    // The time axis's quarters, faintly, behind the bars.
    backgroundImage: `linear-gradient(to right, ${colors.border} 1px, transparent 1px)`,
    backgroundSize: "25% 100%",
    borderInlineEnd: `1px solid ${colors.border}`,
  },
  bar: {
    position: "absolute",
    top: "6px",
    height: "12px",
    minWidth: "3px",
    padding: 0,
    borderWidth: 0,
    borderRadius: "3px",
    cursor: "default",
    outline: "none",
    // Forced colours drop the fill, so a border draws the bar instead.
    boxShadow: {
      default: null,
      ":focus-visible": `0 0 0 2px ${colors.background}, 0 0 0 4px ${colors.focusRing}`,
    },
  },
  // An attempt's bar: thinner than its turn's, under it.
  attemptBar: {
    position: "absolute",
    top: "8px",
    height: "8px",
    minWidth: "3px",
    borderRadius: "2px",
  },
  firstChunk: {
    position: "absolute",
    top: "-3px",
    bottom: "-3px",
    width: "2px",
    marginInlineStart: "-1px",
    backgroundColor: colors.foreground,
    borderRadius: radii.full,
    pointerEvents: "none",
  },
  // A sub-agent's span, from its first turn to its last's end: a bracket over its rows.
  span: {
    position: "absolute",
    top: "10px",
    height: "4px",
    minWidth: "2px",
    borderRadius: radii.full,
    backgroundColor: colors.border,
  },
  attempts: {
    paddingBlock: space.s1,
  },
  // What an attempt was and why it ended, under its bar.
  attemptDetail: {
    gridColumn: "2",
    margin: 0,
    paddingBottom: space.s1,
    fontSize: text.caption,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  code: { fontFamily: fonts.mono },
  attemptFailed: { color: colors.destructive },
  message: {
    display: "block",
    marginTop: space.s0_5,
    color: colors.foreground,
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
 * Each way a turn ended, in its colour; the same in light and dark, as the
 * chart's are. One in flight is striped, its end not yet known.
 */
const fills = stylex.create({
  ok: { backgroundColor: colors.chart1 },
  failed: { backgroundColor: colors.destructive },
  fellBack: { backgroundColor: colors.warning },
  aborted: { backgroundColor: colors.chartOther },
  live: {
    backgroundColor: colors.chart1,
    backgroundImage: `repeating-linear-gradient(135deg, transparent 0 4px, ${colors.background} 4px 6px)`,
    opacity: 0.85,
  },
});

type BarKind = OutcomeKind | "live";

const KINDS: ReadonlyArray<OutcomeKind> = ["ok", "failed", "fellBack", "aborted"];

const kindNames: Readonly<Record<BarKind, string>> = { ...outcomeKindNames, live: "In flight" };

/** Each level of nesting indents its labels this much more. */
const INDENT_PX = 12;

/** A turn's toggle and the gap after it: its attempts' labels start past it, under its number. */
const TOGGLE_PX = 26;

const percent = (share: number) => `${share * 100}%`;

/** An offset from the conversation's start: "0 s", "+12 s", "+4.5 min", "+1.2 h". */
const formatOffset = (ms: number) => (ms <= 0 ? "0 s" : `+${formatDuration(ms)}`);

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

export function Waterfall({ timeline }: { readonly timeline: Timeline }) {
  const rows = flatten(timeline.items);
  const order = rows.map((row) => row.turn.requestId);
  const elements = useRef(new Map<string, HTMLButtonElement>());
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const span = timeline.to - timeline.from;
  const live = rows.some((row) => row.live);

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

  return (
    <div {...stylex.props(styles.root)}>
      <ul aria-label="Legend" {...stylex.props(styles.legend)}>
        {[...KINDS, ...(live ? (["live"] as const) : [])].map((kind) => (
          <li key={kind} {...stylex.props(styles.legendItem)}>
            <span aria-hidden="true" {...stylex.props(styles.swatch, fills[kind])} />
            {kindNames[kind]}
          </li>
        ))}
        <li {...stylex.props(styles.legendItem)}>
          <span aria-hidden="true" {...stylex.props(styles.swatchTick)} />
          First token
        </li>
      </ul>
      <div aria-hidden="true" {...stylex.props(styles.row, styles.axis)}>
        <span />
        <span {...stylex.props(styles.ticks)}>
          {[0, 0.25, 0.5, 0.75, 1].map((share) => (
            <span
              key={share}
              style={{ left: percent(share) }}
              {...stylex.props(
                styles.tick,
                share === 0 && styles.tickStart,
                share === 1 && styles.tickEnd,
                (share === 0.25 || share === 0.75) && styles.tickQuarter,
              )}
            >
              {share === 1 && live ? "now" : formatOffset(share * span)}
            </span>
          ))}
        </span>
      </div>
      <BarsContext value={bars}>
        <ol aria-label="Timeline" {...stylex.props(styles.list)}>
          <Items items={timeline.items} timeline={timeline} depth={0} />
        </ol>
      </BarsContext>
    </div>
  );
}

function Items({
  items,
  timeline,
  depth,
}: {
  readonly items: ReadonlyArray<TimelineItem>;
  readonly timeline: Timeline;
  readonly depth: number;
}) {
  return items.map((item) =>
    item.kind === "turn" ? (
      <TurnRow key={item.turn.requestId} row={item} timeline={timeline} depth={depth} />
    ) : (
      <AgentRows key={item.id} agent={item} timeline={timeline} depth={depth} />
    ),
  );
}

/** What a sub-agent is called: its type when its client said, else a plain "Sub-agent". */
const agentName = (agent: TimelineAgent) => Option.getOrElse(agent.agentType, () => "Sub-agent");

function AgentRows({
  agent,
  timeline,
  depth,
}: {
  readonly agent: TimelineAgent;
  readonly timeline: Timeline;
  readonly depth: number;
}) {
  const turns = flatten(agent.items);
  const start = Math.min(...turns.map((row) => row.start));
  const end = Math.max(...turns.map((row) => row.end));
  const name = agentName(agent);

  return (
    <li>
      <div {...stylex.props(styles.row)}>
        <span
          title={agent.id}
          style={{ paddingInlineStart: depth * INDENT_PX }}
          {...stylex.props(styles.label)}
        >
          <span {...stylex.props(styles.labelText, styles.agent)}>{name}</span>
          <span {...stylex.props(styles.number)}>
            {turns.length} {turns.length === 1 ? "turn" : "turns"}
          </span>
        </span>
        <span aria-hidden="true" {...stylex.props(styles.track)}>
          <span
            style={{ left: percent(start), width: percent(end - start) }}
            {...stylex.props(styles.span)}
          />
        </span>
      </div>
      <ol
        aria-label={Option.isSome(agent.agentType) ? `Sub-agent: ${name}` : "Sub-agent"}
        {...stylex.props(styles.list)}
      >
        <Items items={agent.items} timeline={timeline} depth={depth + 1} />
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
    withoutPrefix(row.turn.model),
    kindNames[kindOf(row)],
    `${formatMs(durationOf(row, timeline))}${row.live ? " so far" : ""}`,
    `at ${formatOffset(row.turn.at - timeline.from)}`,
  ].join(", ");

/** The attempts of a turn that didn't serve, which ended. */
const unserved = (row: TimelineTurn) =>
  row.attempts.filter((placed) => !placed.open && didNotServe(placed.attempt)).length;

/**
 * A turn's row: its toggle, number and model, then its bar; and, opened, its
 * upstream attempts beneath, on the same axis.
 */
function TurnRow({
  row,
  timeline,
  depth,
}: {
  readonly row: TimelineTurn;
  readonly timeline: Timeline;
  readonly depth: number;
}) {
  const { current, register, focused, move } = use(BarsContext);
  const [opened, setOpened] = useState(false);
  const attemptsId = useId();
  const id = row.turn.requestId;
  const count = row.attempts.length;
  const failures = unserved(row);
  const flagged = count > 1 || failures > 0;

  return (
    <li>
      <div {...stylex.props(styles.row)}>
        <span style={{ paddingInlineStart: depth * INDENT_PX }} {...stylex.props(styles.label)}>
          {count === 0 ? (
            <span aria-hidden="true" {...stylex.props(styles.toggleSpace)} />
          ) : (
            <button
              type="button"
              aria-expanded={opened}
              aria-controls={opened ? attemptsId : undefined}
              aria-label={`Attempts of turn ${row.number}${flagged ? `: ${count}, ${failures} failed` : ""}`}
              title={flagged ? `${count} attempts, ${failures} failed` : "Attempts"}
              onClick={() => setOpened((was) => !was)}
              {...stylex.props(styles.toggle)}
            >
              <span {...stylex.props(styles.chevron, opened && styles.chevronOpen)}>
                <ChevronRightIcon size={14} />
              </span>
              {flagged && (
                <span {...stylex.props(styles.retried, failures > 0 && styles.troubled)}>
                  {count}
                </span>
              )}
            </button>
          )}
          <span aria-hidden="true" {...stylex.props(styles.number)}>
            {row.number}
          </span>
          <span title={row.turn.model} {...stylex.props(styles.labelText, styles.model)}>
            {withoutPrefix(row.turn.model)}
          </span>
        </span>
        <span {...stylex.props(styles.track)}>
          <Tooltip content={<TurnDetail row={row} timeline={timeline} />}>
            <button
              type="button"
              ref={register(id)}
              tabIndex={current === id ? 0 : -1}
              aria-label={barName(row, timeline)}
              onFocus={() => focused(id)}
              onKeyDown={move}
              style={{ left: percent(row.start), width: percent(row.end - row.start) }}
              {...stylex.props(styles.bar, fills[kindOf(row)])}
            />
          </Tooltip>
          {Option.isSome(row.firstChunk) && (
            <span
              aria-hidden="true"
              style={{ left: percent(row.firstChunk.value) }}
              {...stylex.props(styles.firstChunk)}
            />
          )}
        </span>
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

/** An attempt's fill: as it ended, or in flight. */
const attemptFill = (placed: TimelineAttempt) =>
  placed.open ? fills.live : didNotServe(placed.attempt) ? fills.failed : fills.ok;

/** What an attempt was and how it ended: its account, model, status, why and code. */
function AttemptRow({
  placed,
  depth,
}: {
  readonly placed: TimelineAttempt;
  readonly depth: number;
}) {
  const mask = useMask();
  const { attempt } = placed;
  const route = routeOf(placed);

  const said = [
    ...Option.match(attempt.accountLabel, {
      onNone: () => [],
      onSome: (label) => [mask.key(label)],
    }),
    withoutPrefix(attempt.model),
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
      <div {...stylex.props(styles.row)}>
        <span
          title={route}
          style={{ paddingInlineStart: depth * INDENT_PX + TOGGLE_PX }}
          {...stylex.props(styles.label)}
        >
          <span aria-hidden="true" {...stylex.props(styles.number)}>
            {attempt.seq + 1}.
          </span>
          <span {...stylex.props(styles.labelText)}>{route}</span>
        </span>
        <span aria-hidden="true" {...stylex.props(styles.track)}>
          <span
            style={{ left: percent(placed.start), width: percent(placed.end - placed.start) }}
            {...stylex.props(styles.attemptBar, attemptFill(placed))}
          />
          {Option.isSome(placed.firstChunk) && (
            <span
              style={{ left: percent(placed.firstChunk.value) }}
              {...stylex.props(styles.firstChunk)}
            />
          )}
        </span>
        <p {...stylex.props(styles.attemptDetail)}>
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
              <span {...stylex.props(styles.code)}>{placed.attempt.upstreamCode.value}</span>
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
        Turn {row.number} · {withoutPrefix(row.turn.model)}
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
