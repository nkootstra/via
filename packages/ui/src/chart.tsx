/**
 * Charts: a stacked bar chart over time, drawn by Recharts in the palette's
 * chart colours, with its own legend and tooltip; and `Stat`, a figure to
 * read at a glance in a description list. The chart fills its container's
 * width, so it fits a phone as well as a desk.
 */
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { colors, fontWeights, radii, shadows, space, text, weights } from "./tokens.stylex.ts";

const styles = stylex.create({
  figure: {
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    minWidth: 0,
  },
  legend: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    display: "flex",
    flexWrap: "wrap",
    columnGap: space.s4,
    rowGap: space.s1_5,
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  legendItem: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  swatch: {
    flexShrink: 0,
    width: "8px",
    height: "8px",
    borderRadius: "2px",
  },
  tooltip: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    minWidth: "10rem",
    maxWidth: "min(18rem, 80vw)",
    padding: space.s2_5,
    borderRadius: radii.item,
    backgroundColor: colors.surface4,
    boxShadow: shadows.surface4,
    fontSize: text.caption,
    color: colors.foreground,
  },
  tooltipTitle: {
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
  },
  tooltipList: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  tooltipRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
  },
  tooltipName: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.mutedForeground,
  },
  tooltipValue: {
    fontVariantNumeric: "tabular-nums",
  },
  tooltipTotal: {
    paddingTop: space.s1,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
  },
  stats: {
    margin: 0,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 9.5rem), 1fr))",
    gap: space.s3,
  },
  stat: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    minWidth: 0,
  },
  statLabel: {
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  statValue: {
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    fontSize: text.stat,
    lineHeight: 1.1,
    letterSpacing: "-0.02em",
    fontVariantNumeric: "tabular-nums",
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
    color: colors.foreground,
    overflowWrap: "anywhere",
  },
  statDetail: {
    fontSize: text.caption,
    letterSpacing: "normal",
    fontVariationSettings: weights.normal,
    fontWeight: fontWeights.normal,
    color: colors.mutedForeground,
  },
});

/** One series of a chart: its id in each point's values, and the name the legend gives it. */
export interface ChartSeries {
  readonly id: string;
  readonly label: string;
  /** The rest, lumped together: drawn grey, after the others. */
  readonly other?: boolean;
}

/** One bar of a chart: where it stands on the x axis, and each series' value there. */
export interface ChartPoint {
  readonly x: number;
  readonly values: ReadonlyMap<string, number>;
}

const PALETTE = [
  colors.chart1,
  colors.chart2,
  colors.chart3,
  colors.chart4,
  colors.chart5,
  colors.chart6,
];

/** The colour of each series: the palette in order, the rest grey, and grey again past six. */
const coloursOf = (series: ReadonlyArray<ChartSeries>) => {
  let next = 0;

  return series.map((one) => {
    if (one.other === true) return colors.chartOther;
    const colour = PALETTE[next] ?? colors.chartOther;
    next += 1;

    return colour;
  });
};

/** Recharts reads values by key, so each series gets a key of its own: `s0`, `s1` and on. */
const keyOf = (index: number) => `s${index}`;

const plain = (value: number) => value.toLocaleString();

export interface ChartTooltipContentProps {
  /** Whether a bar is hovered, and its x; Recharts sets both as the pointer moves. */
  readonly active?: boolean;
  readonly label?: number | string;
  readonly points: ReadonlyArray<ChartPoint>;
  readonly series: ReadonlyArray<ChartSeries>;
  readonly formatX?: ((x: number) => string) | undefined;
  readonly formatValue?: ((value: number) => string) | undefined;
}

/** The hovered bar's series, largest first, and their total. Series with nothing are left out. */
export function ChartTooltipContent({
  active = false,
  label,
  points,
  series,
  formatX = plain,
  formatValue = plain,
}: ChartTooltipContentProps) {
  const x = Number(label);
  const point = points.find((candidate) => candidate.x === x);

  if (!active || point === undefined) return null;
  const colours = coloursOf(series);

  const rows = series
    .map((one, index) => ({ one, value: point.values.get(one.id) ?? 0, colour: colours[index] }))
    .filter((row) => row.value !== 0)
    .toSorted((a, b) => b.value - a.value);

  const total = rows.reduce((sum, row) => sum + row.value, 0);

  return (
    <div {...stylex.props(styles.tooltip)}>
      <span {...stylex.props(styles.tooltipTitle)}>{formatX(point.x)}</span>
      <ul {...stylex.props(styles.tooltipList)}>
        {rows.map(({ one, value, colour }) => (
          <li key={one.id} {...stylex.props(styles.tooltipRow)}>
            <span
              aria-hidden="true"
              {...stylex.props(styles.swatch)}
              style={{ backgroundColor: colour }}
            />
            <span {...stylex.props(styles.tooltipName)}>{one.label}</span>
            <span {...stylex.props(styles.tooltipValue)}>{formatValue(value)}</span>
          </li>
        ))}
        <li {...stylex.props(styles.tooltipRow, styles.tooltipTotal)}>
          <span {...stylex.props(styles.tooltipName)}>Total</span>
          <span {...stylex.props(styles.tooltipValue)}>{formatValue(total)}</span>
        </li>
      </ul>
    </div>
  );
}

export interface BarChartProps {
  /** What the chart shows, which names the figure. */
  readonly label: string;
  readonly points: ReadonlyArray<ChartPoint>;
  /** The series, bottom of each stack first. */
  readonly series: ReadonlyArray<ChartSeries>;
  readonly formatX?: (x: number) => string;
  readonly formatValue?: (value: number) => string;
  /** The plot's height in pixels. */
  readonly height?: number;
}

const axisTick = { fontSize: 11, fill: colors.mutedForeground };

/** A stacked bar chart, one bar per point, one stack segment per series. */
export function BarChart({
  label,
  points,
  series,
  formatX = plain,
  formatValue = plain,
  height = 240,
}: BarChartProps) {
  const colours = coloursOf(series);

  const data = points.map((point) => ({
    x: point.x,
    ...Object.fromEntries(
      series.map((one, index) => [keyOf(index), point.values.get(one.id) ?? 0]),
    ),
  }));

  return (
    <figure aria-label={label} {...stylex.props(styles.figure)}>
      <ResponsiveContainer width="100%" height={height} initialDimension={{ width: 600, height }}>
        <RechartsBarChart
          data={data} // Room on the right for the last tick's label, centred on the last bar.
          margin={{ top: 4, right: 28, bottom: 0, left: 0 }}
        >
          <CartesianGrid vertical={false} stroke={colors.border} />
          <XAxis
            dataKey="x"
            tickFormatter={formatX}
            tick={axisTick}
            tickLine={false}
            axisLine={{ stroke: colors.border }}
            minTickGap={24}
          />
          <YAxis
            tickFormatter={formatValue}
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            width="auto"
          />
          <Tooltip
            cursor={{ fill: colors.hover }}
            // Recharts sets `active` and `label` on the element as the pointer moves.
            content={
              <ChartTooltipContent
                points={points}
                series={series}
                formatX={formatX}
                formatValue={formatValue}
              />
            }
          />
          {series.map((one, index) => (
            <Bar
              key={one.id}
              dataKey={keyOf(index)}
              name={one.label}
              stackId="stack"
              fill={colours[index]}
              // A hairline of the surface between segments tells neighbours apart.
              stroke={colors.surface3}
              strokeWidth={1}
              isAnimationActive={false}
            />
          ))}
        </RechartsBarChart>
      </ResponsiveContainer>
      <ul aria-label="Series" {...stylex.props(styles.legend)}>
        {series.map((one, index) => (
          <li key={one.id} {...stylex.props(styles.legendItem)}>
            <span
              aria-hidden="true"
              {...stylex.props(styles.swatch)}
              style={{ backgroundColor: colours[index] }}
            />
            {one.label}
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** A row of figures, wrapping to fewer columns as the room narrows. */
export function StatList({ children }: { readonly children: ReactNode }) {
  return <dl {...stylex.props(styles.stats)}>{children}</dl>;
}

export interface StatProps {
  readonly label: string;
  readonly value: ReactNode;
  /** A line under the value, such as what it leaves out. */
  readonly detail?: ReactNode;
}

/** One figure of a `StatList`: its name, and its value in large type. */
export function Stat({ label, value, detail }: StatProps) {
  return (
    <div {...stylex.props(styles.stat)}>
      <dt {...stylex.props(styles.statLabel)}>{label}</dt>
      <dd {...stylex.props(styles.statValue)}>
        {value}
        {detail !== undefined && <span {...stylex.props(styles.statDetail)}>{detail}</span>}
      </dd>
    </div>
  );
}
