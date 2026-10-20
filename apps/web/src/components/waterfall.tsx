/**
 * A conversation's waterfall: one row per turn on a shared time axis, its bar
 * from when it came in to when it ended, a tick where its first chunk came,
 * coloured by how it ended. A sub-agent's turns sit on rows nested under the
 * conversation that started it. The bars are one stop for Tab, and the arrow
 * keys move between them; each shows its turn's detail on hover or focus.
 * Nothing moves, so there is no motion to reduce.
 */
import * as stylex from "@stylexjs/stylex";
import { Tooltip } from "@via/ui";
import { colors, fonts, radii, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { Option } from "effect";
import { createContext, use, useRef, useState, type KeyboardEvent } from "react";
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
import type { Timeline, TimelineAgent, TimelineItem, TimelineTurn } from "../lib/timeline.ts";
import { formatDuration, formatMs, formatTokens, formatUsd } from "../lib/usage-format.ts";

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
  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  label: {
    display: "flex",
    alignItems: "baseline",
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
  nested: {
    borderInlineStart: `1px solid ${colors.border}`,
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

/** Each way a turn ended, in its colour; the same in light and dark, as the chart's are. */
const fills = stylex.create({
  ok: { backgroundColor: colors.chart1 },
  failed: { backgroundColor: colors.destructive },
  fellBack: { backgroundColor: colors.warning },
  aborted: { backgroundColor: colors.chartOther },
});

const KINDS: ReadonlyArray<OutcomeKind> = ["ok", "failed", "fellBack", "aborted"];

/** Each level of nesting indents its labels this much more. */
const INDENT_PX = 12;

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
  const order = flatten(timeline.items).map((row) => row.turn.requestId);
  const elements = useRef(new Map<string, HTMLButtonElement>());
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const span = timeline.to - timeline.from;

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
        {KINDS.map((kind) => (
          <li key={kind} {...stylex.props(styles.legendItem)}>
            <span aria-hidden="true" {...stylex.props(styles.swatch, fills[kind])} />
            {outcomeKindNames[kind]}
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
              )}
            >
              {formatOffset(share * span)}
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
        style={{ marginInlineStart: depth * INDENT_PX + 4 }}
        {...stylex.props(styles.list, styles.nested)}
      >
        <Items items={agent.items} timeline={timeline} depth={depth + 1} />
      </ol>
    </li>
  );
}

/** A turn's bar's name: everything its tooltip shows at a glance, for assistive tech. */
const barName = (row: TimelineTurn, timeline: Timeline) =>
  [
    `Turn ${row.number}`,
    withoutPrefix(row.turn.model),
    outcomeKindNames[outcomeKind(row.turn)],
    formatMs(row.turn.durationMs),
    `at ${formatOffset(row.turn.at - timeline.from)}`,
  ].join(", ");

/**
 * A turn's row: its number and model, then its bar. It's an item of its own so
 * that later it can hold rows of its own beneath, as the attempts it took.
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
  const id = row.turn.requestId;
  const kind = outcomeKind(row.turn);

  return (
    <li>
      <div {...stylex.props(styles.row)}>
        <span style={{ paddingInlineStart: depth * INDENT_PX }} {...stylex.props(styles.label)}>
          <span aria-hidden="true" {...stylex.props(styles.number)}>
            {row.number}
          </span>
          <span title={row.turn.model} {...stylex.props(styles.labelText, styles.model)}>
            {withoutPrefix(row.turn.model)}
          </span>
        </span>
        <span {...stylex.props(styles.track)}>
          <Tooltip content={<TurnDetail row={row} />}>
            <button
              type="button"
              ref={register(id)}
              tabIndex={current === id ? 0 : -1}
              aria-label={barName(row, timeline)}
              onFocus={() => focused(id)}
              onKeyDown={move}
              style={{ left: percent(row.start), width: percent(row.end - row.start) }}
              {...stylex.props(styles.bar, fills[kind])}
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
    </li>
  );
}

/** Who answered a turn: the provider, and the account when one of a pool's did. */
const servedBy = (turn: TimelineTurn["turn"], hide: (name: string) => string) =>
  Option.match(turn.accountLabel, {
    onNone: () => providerName(turn.provider),
    onSome: (label) => `${providerName(turn.provider)} · ${hide(label)}`,
  });

/** A turn's tokens: what it sent, of it cached, and what came back. */
const tokensDetail = (turn: TimelineTurn["turn"]) =>
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

function TurnDetail({ row }: { readonly row: TimelineTurn }) {
  const mask = useMask();
  const { turn } = row;

  const entries: ReadonlyArray<readonly [string, string]> = [
    ...Option.match(turn.requestedModel, {
      onNone: () => [],
      onSome: (asked): ReadonlyArray<readonly [string, string]> => [
        ["Fallback", `Fell back from ${withoutPrefix(asked)}`],
      ],
    }),
    ["Served by", servedBy(turn, mask.key)],
    ["Tokens", tokensDetail(turn)],
    ...Option.match(turn.costUsd, {
      onNone: () => [],
      onSome: (usd): ReadonlyArray<readonly [string, string]> => [["Billed", formatUsd(usd)]],
    }),
    ["Duration", formatMs(turn.durationMs)],
    ...Option.match(turn.firstChunkMs, {
      onNone: () => [],
      onSome: (ms): ReadonlyArray<readonly [string, string]> => [["First token", formatMs(ms)]],
    }),
    ["Outcome", `${outcomeOf(turn)} (${outcomeDetail(turn)})`],
    ...Option.match(turn.errorMessage, {
      onNone: () => [],
      onSome: (message): ReadonlyArray<readonly [string, string]> => [["Why", mask.key(message)]],
    }),
  ];

  return (
    <>
      <span {...stylex.props(styles.detailTitle)}>
        Turn {row.number} · {withoutPrefix(turn.model)}
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
