import * as stylex from "@stylexjs/stylex";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  BarChart,
  Button,
  Callout,
  type ChartPoint,
  type ChartSeries,
  EmptyState,
  SegmentedControl,
  SegmentedItem,
  Skeleton,
  Stat,
  StatList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeleton,
} from "@via/ui";
import { colors, fonts, radii, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { Option } from "effect";
import { useState } from "react";
import {
  historyBreakdownQuery,
  historyRequestsQuery,
  historySeriesQuery,
  type HistoryGroupBy,
  type HistoryRange,
  type RequestFilter,
} from "../../api/admin.ts";
import type {
  HistoryBreakdown,
  HistoryGroup,
  HistorySeries,
  UsageRequest,
} from "../../api/types.ts";
import { CodexIcon, ProviderLogo, UsageIcon } from "../../components/icons.tsx";
import { Page, Panel, Section } from "../../components/page.tsx";
import { QueryError } from "../../components/query-error.tsx";
import { formatDay, formatHour, formatMoment, useNow } from "../../lib/time.ts";
import { useTimeFormat } from "../../lib/time-format.ts";
import { ownerOf, withoutPrefix } from "../../lib/model-entries.ts";
import { providerName } from "../../lib/provider-name.ts";
import {
  formatCount,
  formatMs,
  formatShare,
  formatTokens,
  formatUsd,
} from "../../lib/usage-format.ts";

export const Route = createFileRoute("/_app/usage")({
  head: () => ({ meta: [{ title: "Usage · via" }] }),
  component: Usage,
});

const HOUR = 3_600_000;

const DAY = 24 * HOUR;

/**
 * The spans the page looks back over: the last 24 hours in hours, the rest in
 * days. The labels are short so all four fit across a phone.
 */
const RANGES = {
  "24h": { label: "Day", days: 1, bucket: "hour" },
  "7d": { label: "Week", days: 7, bucket: "day" },
  "30d": { label: "30 days", days: 30, bucket: "day" },
  "90d": { label: "90 days", days: 90, bucket: "day" },
} as const;

type RangeKey = keyof typeof RANGES;

const isRange = (value: string): value is RangeKey => Object.hasOwn(RANGES, value);

const GROUPINGS = { model: "Model", account: "Account", key: "Key" } as const;

const isGrouping = (value: string): value is HistoryGroupBy => Object.hasOwn(GROUPINGS, value);

/** How many groups the chart colours on their own; the rest share the grey of Other. */
const CHART_SERIES = 5;

const styles = stylex.create({
  controls: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
  },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: space.s6,
    minWidth: 0,
  },
  scroll: { overflowX: "auto" },
  name: {
    display: "block",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
  },
  // A group's name that picks its requests: reads as the name, acts as a button.
  pick: {
    maxWidth: "100%",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    font: "inherit",
    textAlign: "start",
    cursor: "pointer",
    textDecorationLine: { default: "none", ":hover": "underline" },
    textUnderlineOffset: "3px",
    outlineOffset: "2px",
    borderRadius: radii.item,
  },
  number: {
    fontVariantNumeric: "tabular-nums",
    textAlign: "end",
    whiteSpace: "nowrap",
  },
  mono: {
    fontFamily: fonts.mono,
    fontSize: text.caption,
  },
  failed: { color: colors.destructive },
  model: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    minWidth: 0,
  },
  logo: {
    display: "flex",
    flexShrink: 0,
    color: colors.mutedForeground,
  },
  modelId: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  when: {
    display: "block",
    marginTop: space.s0_5,
    fontSize: text.caption,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  // Why a request failed, under its outcome: two lines at most, all of it on hover.
  cause: {
    display: "-webkit-box",
    marginTop: space.s0_5,
    overflow: "hidden",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    overflowWrap: "anywhere",
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  outcome: {
    display: "block",
    overflowWrap: "anywhere",
    color: colors.foreground,
  },
  filter: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  filterValue: {
    fontFamily: fonts.mono,
    color: colors.foreground,
    overflowWrap: "anywhere",
  },
  more: {
    display: "flex",
    justifyContent: "center",
    padding: space.s3,
  },
});

/** Where the range ends: the end of the current hour, or of today on the viewer's clock. */
const rangeOf = (key: RangeKey, now: number): HistoryRange => {
  const range = RANGES[key];
  const end = new Date(now);

  if (range.bucket === "hour") {
    end.setMinutes(60, 0, 0);
  } else {
    end.setHours(24, 0, 0, 0);
  }

  const to = end.getTime();

  return { from: to - range.days * DAY, to };
};

/** Tokens a group or a point spent: what it sent and what it got back. */
const tokensOf = (usage: { readonly inputTokens: number; readonly outputTokens: number }) =>
  usage.inputTokens + usage.outputTokens;

/**
 * A group's name as the page shows it: a model without its provider's prefix,
 * as the Models page names it; any other group by its label.
 */
const nameOf = (groupBy: HistoryGroupBy, group: HistoryGroup) =>
  groupBy === "model" ? withoutPrefix(group.label) : group.label;

/**
 * The chart's series: the groups that spent the most tokens, then the rest
 * as one grey Other. Models are named without their prefix, and with their
 * provider where two shown would otherwise share a name.
 */
const seriesOf = (
  groupBy: HistoryGroupBy,
  groups: ReadonlyArray<HistoryGroup>,
): ReadonlyArray<ChartSeries> => {
  const ranked = groups.toSorted((a, b) => tokensOf(b) - tokensOf(a));
  const top = ranked.slice(0, CHART_SERIES);
  const names = top.map((g) => nameOf(groupBy, g));

  const shown = top.map((g, index) => {
    const name = names[index] ?? g.label;
    const shared = names.filter((other) => other === name).length > 1;

    return {
      id: g.group,
      label: shared && groupBy === "model" ? `${name} · ${providerName(ownerOf(g.group))}` : name,
    };
  });

  return ranked.length > CHART_SERIES
    ? [...shown, { id: "other", label: "Other", other: true }]
    : shown;
};

/** One bar per hour or day of the range, empty ones too, so the axis keeps time. */
const pointsOf = (
  series: HistorySeries,
  shown: ReadonlyArray<ChartSeries>,
  range: HistoryRange,
  bucket: "hour" | "day",
): ReadonlyArray<ChartPoint> => {
  const size = bucket === "hour" ? HOUR : DAY;
  const ids = new Set(shown.map((one) => one.id));
  const bars = new Map<number, Map<string, number>>();

  for (let at = range.from; at < range.to; at += size) bars.set(at, new Map());

  for (const point of series.points) {
    const values = bars.get(point.bucket) ?? new Map<string, number>();
    const id = ids.has(point.group) ? point.group : "other";
    values.set(id, (values.get(id) ?? 0) + tokensOf(point));
    bars.set(point.bucket, values);
  }

  return [...bars].toSorted(([a], [b]) => a - b).map(([x, values]) => ({ x, values }));
};

/** What a group's requests are filtered by, if the list can show only them. */
const filterOf = (groupBy: HistoryGroupBy, group: HistoryGroup): RequestFilter | undefined => {
  if (groupBy === "model") return { model: group.group };

  if (groupBy === "key") return { keyId: group.group };

  // A plain provider has no account of its own to filter by.
  return group.group.startsWith("provider:") ? undefined : { accountId: group.group };
};

function Usage() {
  const format = useTimeFormat();
  const now = useNow(60_000);
  const [rangeKey, setRangeKey] = useState<RangeKey>("24h");
  const [groupBy, setGroupBy] = useState<HistoryGroupBy>("model");
  const [filter, setFilter] = useState<{ label: string; by: RequestFilter } | undefined>();
  const bucket = RANGES[rangeKey].bucket;
  const range = rangeOf(rangeKey, now);
  const tzOffsetMinutes = -new Date(now).getTimezoneOffset();

  const breakdown = useQuery({
    ...historyBreakdownQuery(range, groupBy),
    placeholderData: keepPreviousData,
  });

  const series = useQuery({
    ...historySeriesQuery(range, bucket, tzOffsetMinutes, groupBy),
    placeholderData: keepPreviousData,
  });

  const controls = (
    <div {...stylex.props(styles.controls)}>
      <SegmentedControl
        aria-label="Range"
        value={rangeKey}
        onValueChange={(value) => isRange(value) && setRangeKey(value)}
      >
        {Object.entries(RANGES).map(([key, { label }]) => (
          <SegmentedItem key={key} value={key} label={label} />
        ))}
      </SegmentedControl>
      <SegmentedControl
        aria-label="Group by"
        value={groupBy}
        onValueChange={(value) => isGrouping(value) && setGroupBy(value)}
      >
        {Object.entries(GROUPINGS).map(([key, label]) => (
          <SegmentedItem key={key} value={key} label={label} />
        ))}
      </SegmentedControl>
    </div>
  );

  return (
    <Page
      title="Usage"
      description="Every request via served in the last 90 days: who sent it, which account answered, and the tokens it took."
    >
      <div {...stylex.props(styles.content)}>
        {controls}
        {breakdown.isError ? (
          <QueryError
            what="usage"
            error={breakdown.error}
            onRetry={() => void breakdown.refetch()}
          />
        ) : breakdown.data === undefined ? (
          <UsageLoading />
        ) : breakdown.data.totals.requests === 0 ? (
          <EmptyState
            icon={<UsageIcon size={18} />}
            title={`No requests in the last ${RANGES[rangeKey].label.toLowerCase()}`}
            description="Requests your clients send through via show up here, with their tokens and what they would cost."
            headingLevel={2}
          />
        ) : (
          <>
            <Totals breakdown={breakdown.data} />
            <Panel>
              {series.data === undefined ? (
                <Skeleton height="240px" />
              ) : (
                <BarChart
                  label={bucket === "hour" ? "Tokens per hour" : "Tokens per day"}
                  points={pointsOf(
                    series.data,
                    seriesOf(groupBy, breakdown.data.groups),
                    range,
                    bucket,
                  )}
                  series={seriesOf(groupBy, breakdown.data.groups)}
                  formatX={(x) => (bucket === "hour" ? formatHour(x, format) : formatDay(x))}
                  formatValue={formatTokens}
                />
              )}
            </Panel>
            <Section title={`By ${GROUPINGS[groupBy].toLowerCase()}`}>
              <Breakdown
                breakdown={breakdown.data}
                groupBy={groupBy}
                onPick={(group) => {
                  const by = filterOf(groupBy, group);

                  if (by !== undefined) setFilter({ label: nameOf(groupBy, group), by });
                }}
              />
            </Section>
            <Section title="Requests">
              <Requests
                range={range}
                filter={filter}
                onClear={() => setFilter(undefined)}
                format={format}
              />
            </Section>
          </>
        )}
      </div>
    </Page>
  );
}

function Totals({ breakdown }: { readonly breakdown: HistoryBreakdown }) {
  const { totals } = breakdown;
  // Failed requests have no tokens to report, so only answered ones count here.
  const unmeasured = totals.unmeasured;
  const { cost } = totals;

  const costDetail =
    cost.unpriced.length > 0
      ? `Leaves out ${cost.unpriced.join(", ")}: no price known`
      : cost.billedUsd > 0
        ? `Plus ${formatUsd(cost.billedUsd)} billed`
        : "At API prices";

  return (
    <>
      <StatList>
        <Stat
          label="Requests"
          value={formatCount(totals.requests)}
          detail={totals.errors > 0 ? `${formatCount(totals.errors)} failed` : undefined}
        />
        <Stat
          label="Tokens"
          value={formatTokens(tokensOf(totals))}
          detail={`${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out`}
        />
        <Stat
          label="Cache hit rate"
          value={formatShare(totals.cachedTokens, totals.inputTokens)}
          detail="of input tokens"
        />
        <Stat
          label="API-equivalent cost"
          value={formatUsd(cost.apiEquivalentUsd)}
          detail={costDetail}
        />
        {Option.isSome(totals.firstChunkMs.p95) && (
          <Stat
            label="Time to first token"
            value={formatMs(totals.firstChunkMs.p95.value)}
            detail={Option.match(totals.firstChunkMs.p50, {
              onNone: () => "p95",
              onSome: (median) => `p95 · median ${formatMs(median)}`,
            })}
          />
        )}
      </StatList>
      {unmeasured > 0 && (
        <Callout tone="info">
          {unmeasured === 1
            ? "1 request reported no token usage, so the token totals and cost leave it out."
            : `${formatCount(unmeasured)} requests reported no token usage, so the token totals and cost leave them out.`}
        </Callout>
      )}
    </>
  );
}

/**
 * The breakdown table's columns: name, requests, tokens, share, cost, failed.
 * A phone keeps the name, tokens and cost.
 */
const breakdownColumns = [
  "auto",
  { width: "14%", secondary: true },
  "18%",
  { width: "11%", secondary: true },
  "22%",
  { width: "11%", secondary: true },
] as const;

/**
 * A model as the page names it: its provider's logo, which reads out as the
 * provider, then its id without the prefix; the full id on hover.
 */
function ModelName({ id }: { readonly id: string }) {
  const owner = ownerOf(id);

  return (
    <span title={id} {...stylex.props(styles.model)}>
      <span {...stylex.props(styles.logo)}>
        {owner === "Codex" ? (
          <CodexIcon size={14} label="Codex" />
        ) : (
          <ProviderLogo name={owner} size={14} label={providerName(owner)} />
        )}
      </span>
      <span {...stylex.props(styles.modelId)}>{withoutPrefix(id)}</span>
    </span>
  );
}

function Breakdown({
  breakdown,
  groupBy,
  onPick,
}: {
  readonly breakdown: HistoryBreakdown;
  readonly groupBy: HistoryGroupBy;
  readonly onPick: (group: HistoryGroup) => void;
}) {
  const total = tokensOf(breakdown.totals);

  return (
    <Panel flush>
      <div {...stylex.props(styles.scroll)}>
        <Table
          aria-label={`Usage by ${GROUPINGS[groupBy].toLowerCase()}`}
          columns={breakdownColumns}
        >
          <TableHeader>
            <TableRow>
              <TableHead>{GROUPINGS[groupBy]}</TableHead>
              <TableHead secondary>Requests</TableHead>
              <TableHead>Tokens</TableHead>
              <TableHead secondary>Share</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead secondary>Failed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {breakdown.groups.map((group, index) => (
              <TableRow key={group.group} index={index}>
                <TableCell>
                  {filterOf(groupBy, group) === undefined ? (
                    <span title={group.label} {...stylex.props(styles.name)}>
                      {group.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Show requests for ${group.label}`}
                      // A model names its full id itself.
                      title={groupBy === "model" ? undefined : group.label}
                      onClick={() => onPick(group)}
                      {...stylex.props(styles.name, styles.pick)}
                    >
                      {groupBy === "model" ? <ModelName id={group.group} /> : group.label}
                    </button>
                  )}
                </TableCell>
                <TableCell secondary>
                  <span {...stylex.props(styles.number)}>{formatCount(group.requests)}</span>
                </TableCell>
                <TableCell>
                  <span {...stylex.props(styles.number)}>{formatTokens(tokensOf(group))}</span>
                </TableCell>
                <TableCell secondary>
                  <span {...stylex.props(styles.number)}>
                    {formatShare(tokensOf(group), total)}
                  </span>
                </TableCell>
                <TableCell>
                  <span {...stylex.props(styles.number)}>
                    {formatUsd(group.cost.apiEquivalentUsd + group.cost.billedUsd)}
                  </span>
                </TableCell>
                <TableCell secondary>
                  <span {...stylex.props(styles.number, group.errors > 0 && styles.failed)}>
                    {formatCount(group.errors)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Panel>
  );
}

/** The errors via answers itself, in a word or two; the code itself is the cell's title. */
const errorNames = new Map([
  ["rate_limit_exceeded", "Rate limited"],
  ["no_accounts", "No account"],
  ["upstream_unavailable", "Unreachable"],
  ["upstream_timeout", "Timed out"],
  ["upstream_too_large", "Too large"],
  ["invalid_request", "Bad request"],
]);

/** How a request ended, in a word or two. */
const outcomeOf = (request: UsageRequest) =>
  Option.match(request.error, {
    onSome: (code) => errorNames.get(code) ?? code,
    onNone: () =>
      Option.contains(request.streamEnd, "failed")
        ? "Broke off"
        : request.status === 499
          ? "Client left"
          : request.status >= 400
            ? `Error ${request.status}`
            : "OK",
  });

/** The outcome's code or status, for its title. */
const outcomeDetail = (request: UsageRequest) =>
  Option.getOrElse(request.error, () => `HTTP ${request.status}`);

const failed = (request: UsageRequest) =>
  (request.status >= 400 && request.status !== 499) || Option.contains(request.streamEnd, "failed");

/**
 * The request list's columns: the request (its model over its time), key,
 * served by, tokens and outcome. A phone keeps the request, tokens and outcome.
 */
const requestColumns = [
  "auto",
  { width: "18%", secondary: true },
  { width: "18%", secondary: true },
  "18%",
  "26%",
] as const;

function Requests({
  range,
  filter,
  onClear,
  format,
}: {
  readonly range: HistoryRange;
  readonly filter: { readonly label: string; readonly by: RequestFilter } | undefined;
  readonly onClear: () => void;
  readonly format: ReturnType<typeof useTimeFormat>;
}) {
  const requests = useInfiniteQuery(historyRequestsQuery(range, filter?.by ?? {}));

  const rows = requests.data?.pages.flatMap((page) => page.requests) ?? [];

  return (
    <>
      {filter !== undefined && (
        <div {...stylex.props(styles.filter)}>
          Only requests for
          <span data-filter {...stylex.props(styles.filterValue)}>
            {filter.label}
          </span>
          <Button variant="ghost" size="compact" onClick={onClear}>
            Show all requests
          </Button>
        </div>
      )}
      {requests.isError ? (
        <QueryError
          what="requests"
          error={requests.error}
          onRetry={() => void requests.refetch()}
        />
      ) : requests.data === undefined ? (
        <TableSkeleton rows={3} columns={requestColumns} label="Loading requests" />
      ) : (
        <Panel flush>
          <div {...stylex.props(styles.scroll)}>
            <Table aria-label="Requests" columns={requestColumns}>
              <TableHeader>
                <TableRow>
                  <TableHead>Request</TableHead>
                  <TableHead secondary>Key</TableHead>
                  <TableHead secondary>Served by</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((request, index) => (
                  <TableRow key={request.requestId} index={index}>
                    <TableCell>
                      <span {...stylex.props(styles.name, styles.mono)}>
                        <ModelName id={request.model} />
                      </span>
                      <span {...stylex.props(styles.when)}>{formatMoment(request.at, format)}</span>
                    </TableCell>
                    <TableCell secondary>{Option.getOrElse(request.keyName, () => "–")}</TableCell>
                    <TableCell secondary>
                      {Option.getOrElse(request.accountLabel, () =>
                        request.provider === "codex" ? "–" : request.provider,
                      )}
                    </TableCell>
                    <TableCell>
                      <span {...stylex.props(styles.number)}>
                        {Option.match(request.inputTokens, {
                          onNone: () => "–",
                          onSome: (input) =>
                            formatTokens(input + Option.getOrElse(request.outputTokens, () => 0)),
                        })}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span
                        title={outcomeDetail(request)}
                        {...stylex.props(styles.outcome, failed(request) && styles.failed)}
                      >
                        {outcomeOf(request)}
                      </span>
                      {Option.isSome(request.errorMessage) && (
                        <span title={request.errorMessage.value} {...stylex.props(styles.cause)}>
                          {request.errorMessage.value}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {requests.hasNextPage && (
            <div {...stylex.props(styles.more)}>
              <Button
                variant="secondary"
                disabled={requests.isFetchingNextPage}
                onClick={() => void requests.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}

function UsageLoading() {
  return (
    <>
      <StatList>
        {["Requests", "Tokens", "Cache hit rate", "API-equivalent cost"].map((label) => (
          <Stat key={label} label={label} value={<Skeleton width="64px" height="26px" />} />
        ))}
      </StatList>
      <Panel>
        <Skeleton height="240px" />
      </Panel>
    </>
  );
}
