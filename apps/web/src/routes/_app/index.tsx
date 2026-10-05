import * as stylex from "@stylexjs/stylex";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";
import { Badge, Button, Callout, EmptyState, Meter, Skeleton, VisuallyHidden } from "@via/ui";
import { colors, durations, radii, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { useId, type ReactNode } from "react";
import { accountsQuery, historyBreakdownQuery, poolQuery, usageQuery } from "../../api/admin.ts";
import { useLiveOptions, useSignalledOptions } from "../../api/live.ts";
import { useAddAccount } from "../../components/add-account.tsx";
import { BackIn } from "../../components/back-in.tsx";
import { AccountsIcon, CodexIcon, PlusIcon, ProviderLogo } from "../../components/icons.tsx";
import { Page, Panel, Section } from "../../components/page.tsx";
import { QueryError } from "../../components/query-error.tsx";
import { ago, formatTime, providerWindowName, useNow, windowName } from "../../lib/time.ts";
import { useTimeFormat } from "../../lib/time-format.ts";
import { useMask } from "../../lib/privacy.ts";
import { providerName } from "../../lib/provider-name.ts";
import { poolReason } from "../../lib/pool-reason.ts";
import { historyRange } from "../../lib/history-range.ts";
import { formatCount, formatTokens, formatUsd, tokensOf } from "../../lib/usage-format.ts";
import type { HistoryGroup, PoolAccount, PoolProvider, Usage } from "../../api/types.ts";

export const Route = createFileRoute("/_app/")({
  head: () => ({ meta: [{ title: "Overview · via" }] }),
  // Data the shell or the stream brought is there already; otherwise the page waits for it.
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.ensureQueryData(poolQuery),
      queryClient.ensureQueryData(usageQuery),
      queryClient.ensureQueryData(accountsQuery),
    ]),
  pendingComponent: OverviewLoading,
  errorComponent: OverviewError,
  component: Overview,
});

const styles = stylex.create({
  stats: {
    margin: 0,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
    gap: space.s3,
  },
  // The count keeps to the tile's foot, so counts in a row line up however their labels wrap.
  stat: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    gap: space.s1,
  },
  // The dot keeps to the label's first line.
  statLabel: {
    display: "flex",
    alignItems: "baseline",
    gap: space.s1_5,
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  statValue: {
    margin: 0,
    fontSize: text.stat,
    lineHeight: 1.1,
    letterSpacing: "-0.02em",
    fontVariantNumeric: "tabular-nums",
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
    color: colors.foreground,
  },
  statOf: {
    fontSize: text.subtitle,
    color: colors.mutedForeground,
    fontVariationSettings: weights.normal,
    fontWeight: fontWeights.normal,
  },
  dot: {
    flexShrink: 0,
    width: "7px",
    height: "7px",
    borderRadius: radii.full,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))",
    gap: space.s3,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    height: "100%",
  },
  cardHead: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.s3,
  },
  identity: {
    display: "flex",
    alignItems: "center",
    gap: space.s2_5,
    minWidth: 0,
  },
  who: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space.s0_5,
    minWidth: 0,
  },
  // A long name or email wraps rather than hiding its end: on a phone the badge beside it
  // leaves little room.
  name: {
    margin: 0,
    maxWidth: "100%",
    overflowWrap: "anywhere",
    fontSize: text.subtitle,
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
    color: colors.foreground,
  },
  email: {
    maxWidth: "100%",
    overflowWrap: "anywhere",
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  providerIcon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: "32px",
    height: "32px",
    borderRadius: radii.item,
    backgroundColor: colors.muted,
    color: colors.foreground,
  },
  // via's reasons and an email can be one unbroken string; they wrap rather than widen the page.
  state: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    overflowWrap: "anywhere",
  },
  stateTitle: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s2,
    color: colors.foreground,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
  },
  reason: { color: colors.mutedForeground },
  fix: { marginTop: space.s1 },
  meters: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
  },
  // What via counted for a provider, in the shape of the meters beside it.
  counted: {
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
  },
  figure: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    alignItems: "baseline",
    rowGap: space.s1_5,
    columnGap: space.s2,
    minWidth: 0,
  },
  figureLabel: {
    fontSize: text.caption,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
  },
  figureValue: {
    margin: 0,
    fontSize: text.caption,
    fontVariantNumeric: "tabular-nums",
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.mutedForeground,
  },
  figureDetail: {
    gridColumn: "1 / -1",
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    margin: 0,
    overflowWrap: "anywhere",
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  // A meter's track, filled in a neutral tone: a share of via's traffic, not a limit.
  shareTrack: {
    position: "relative",
    height: "6px",
    overflow: "hidden",
    borderRadius: radii.full,
    backgroundColor: colors.muted,
    boxShadow: `inset 0 0 0 1px ${colors.border}`,
  },
  shareFill: {
    position: "absolute",
    insetBlock: 0,
    insetInlineStart: 0,
    borderRadius: radii.full,
    backgroundColor: colors.mutedForeground,
  },
  // Keeps to the card's foot, as the last reset line does beside it.
  requestsLink: {
    marginTop: "auto",
    alignSelf: "flex-start",
    fontSize: text.caption,
    color: colors.mutedForeground,
    textDecorationLine: { default: "none", ":hover": "underline" },
    textUnderlineOffset: "3px",
    borderRadius: radii.item,
    outlineOffset: "2px",
  },
  muted: {
    margin: 0,
    overflowWrap: "anywhere",
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  updated: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    fontVariantNumeric: "tabular-nums",
  },
  // Sits beside "Updated …" while via fetches newer usage, and holds its place when idle.
  fetching: {
    width: "6px",
    height: "6px",
    borderRadius: radii.full,
    backgroundColor: colors.mutedForeground,
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: durations.moderate,
  },
  fetchingOn: {
    opacity: 1,
    animationName: stylex.keyframes({
      "0%, 100%": { opacity: 1 },
      "50%": { opacity: 0.3 },
    }),
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
    "@media (prefers-reduced-motion: reduce)": {
      animationName: "none",
    },
  },
  skeletonHead: {
    display: "flex",
    alignItems: "center",
    gap: space.s2_5,
  },
  skeletonWho: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    flexGrow: 1,
  },
});

const stateColors = stylex.create({
  green: { backgroundColor: colors.success },
  amber: { backgroundColor: colors.warning },
  red: { backgroundColor: colors.destructive },
  gray: { backgroundColor: colors.mutedForeground },
});

/** A summary tile; its dot takes its state's colour only while something is in it. */
function Stat({
  label,
  color,
  count,
  children,
}: {
  readonly label: string;
  readonly color: keyof typeof stateColors;
  readonly count: number;
  /** What follows the count, such as "of 6". */
  readonly children?: ReactNode;
}) {
  const tone = count === 0 ? "gray" : color;

  return (
    <Panel xstyle={styles.stat}>
      <dt {...stylex.props(styles.statLabel)}>
        <span aria-hidden="true" {...stylex.props(styles.dot, stateColors[tone])} />
        {label}
      </dt>
      <dd {...stylex.props(styles.statValue)}>
        {count}
        {children}
      </dd>
    </Panel>
  );
}

function AccountBadge({ account }: { readonly account: PoolAccount }) {
  if (!account.enabled) return <Badge variant="dot">Disabled</Badge>;

  switch (account.state.status) {
    case "available":
      return (
        <Badge variant="dot" color="green">
          Available
        </Badge>
      );
    case "cooling":
      return (
        <Badge variant="dot" color="amber">
          Cooling down
        </Badge>
      );
    case "auth_error":
      return (
        <Badge variant="dot" color="red">
          Locked out
        </Badge>
      );
  }
}

function ProviderBadge({ provider }: { readonly provider: PoolProvider }) {
  switch (provider.state.status) {
    case "available":
      return (
        <Badge variant="dot" color="green">
          Available
        </Badge>
      );
    case "exhausted":
      return (
        <Badge variant="dot" color="amber">
          Exhausted
        </Badge>
      );
    case "unavailable":
      return (
        <Badge variant="dot" color="red">
          Unavailable
        </Badge>
      );
  }
}

/** A state that passes on its own: back in a countdown, why, and when it ends. */
function Resting({
  until,
  reason,
  ends,
}: {
  readonly until: string;
  readonly reason: string;
  readonly ends: string;
}) {
  const format = useTimeFormat();
  const mask = useMask();

  return (
    <Callout tone="warning">
      <div {...stylex.props(styles.state)}>
        <span {...stylex.props(styles.stateTitle)}>
          <BackIn until={until} />
        </span>
        <span {...stylex.props(styles.reason)}>{mask.text(reason)}</span>
        <span {...stylex.props(styles.reason)}>
          {ends} {formatTime(until, format)}
        </span>
      </div>
    </Callout>
  );
}

/** A state someone has to fix: what to do, and why. */
function Blocked({
  title,
  reason,
  action,
}: {
  readonly title: string;
  readonly reason: string;
  /** A button that fixes it, where the app can. */
  readonly action?: ReactNode;
}) {
  const mask = useMask();

  return (
    <Callout tone="danger">
      <div {...stylex.props(styles.state)}>
        <span {...stylex.props(styles.stateTitle)}>{mask.text(title)}</span>
        <span {...stylex.props(styles.reason)}>{mask.text(reason)}</span>
        {action !== undefined && <div {...stylex.props(styles.fix)}>{action}</div>}
      </div>
    </Callout>
  );
}

function AccountDetail({
  account,
  locked,
}: {
  readonly account: PoolAccount;
  /** What to do about the account once it is locked out, and why; via's own reason by default. */
  readonly locked: {
    readonly title: string;
    readonly reason?: string;
    readonly action?: ReactNode;
  };
}) {
  const { state } = account;

  if (!account.enabled || state.status === "available") return null;

  return state.status === "cooling" ? (
    <Resting until={state.until} reason={poolReason(state.reason)} ends="Ends" />
  ) : (
    <Blocked
      title={locked.title}
      reason={locked.reason ?? poolReason(state.reason)}
      {...(locked.action !== undefined && { action: locked.action })}
    />
  );
}

function ProviderDetail({ provider }: { readonly provider: PoolProvider }) {
  const { state } = provider;

  switch (state.status) {
    case "available":
      return null;
    case "exhausted":
      return (
        <Resting
          until={state.until}
          reason={`${providerWindowName(state.window)} limit used up`}
          ends="Resets"
        />
      );
    case "unavailable":
      return <Blocked title="Usage can't be read" reason={state.reason} />;
  }
}

function Windows({
  windows,
}: {
  readonly windows: ReadonlyArray<{
    readonly label: string;
    readonly usedPercent: number;
    readonly resetsAt: string;
  }>;
}) {
  const format = useTimeFormat();

  return (
    <div {...stylex.props(styles.meters)}>
      {windows.map((window) => (
        <Meter
          key={window.label}
          label={window.label}
          value={window.usedPercent}
          detail={`Resets ${formatTime(window.resetsAt, format)}`}
        />
      ))}
    </div>
  );
}

function UsageLoading() {
  return (
    <output aria-label="Loading usage" {...stylex.props(styles.meters)}>
      <Skeleton width="40%" height="12px" />
      <Skeleton height="6px" />
      <Skeleton width="55%" height="12px" />
      <Skeleton height="6px" />
    </output>
  );
}

/**
 * What a card shows while via has no usage for its account: bars loading while
 * it is fetching, or that there is none yet.
 */
function UsageMissing({ usage }: { readonly usage: Usage }) {
  return usage.refreshing ? (
    <UsageLoading />
  ) : (
    <p {...stylex.props(styles.muted)}>No usage reported yet.</p>
  );
}

/**
 * Why an account's usage couldn't be read, and that via keeps asking. via's
 * reason may open with a provider's id and close with a full stop of its own.
 */
function UsageFailed({ error }: { readonly error: string }) {
  const mask = useMask();
  const reason = mask.key(error.replace(/^[\w-]+/, providerName).replace(/\.$/, ""));

  return (
    <p {...stylex.props(styles.muted)}>
      Usage unavailable: {reason}. via asks again on its next refresh.
    </p>
  );
}

function AccountUsage({ id, usage }: { readonly id: string; readonly usage: Usage }) {
  const entry = usage.accounts.find((account) => account.id === id);

  if (entry === undefined) return <UsageMissing usage={usage} />;

  if ("error" in entry) return <UsageFailed error={entry.error} />;

  return (
    <Windows
      windows={entry.windows.map((window) => ({
        label: windowName(window.windowMinutes),
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
      }))}
    />
  );
}

function OpencodeGoUsage({ id, usage }: { readonly id: string; readonly usage: Usage }) {
  const entry = usage.opencodeGo.find((account) => account.id === id);

  if (entry === undefined) return <UsageMissing usage={usage} />;

  if ("error" in entry) return <UsageFailed error={entry.error} />;

  return (
    <Windows
      windows={entry.windows.map((window) => ({
        label: providerWindowName(window.window),
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
      }))}
    />
  );
}

/** A share as a whole percentage, and as under 1% rather than 0% when it isn't nothing. */
const shareOf = (part: number, total: number) => {
  const percent = total === 0 ? 0 : (part / total) * 100;

  return { percent, text: percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%` };
};

/** What a provider's requests cost, and why: what it billed, the rest at API prices, or nothing. */
const costOf = ({ cost }: HistoryGroup, name: string) => {
  if (cost.unpriced.length > 0) {
    return { value: "Unknown", detail: `No price known for ${cost.unpriced.join(", ")}` };
  }

  if (cost.billedUsd > 0 && cost.apiEquivalentUsd === 0) {
    return { value: formatUsd(cost.billedUsd), detail: `Billed by ${providerName(name)}` };
  }

  const total = cost.apiEquivalentUsd + cost.billedUsd;

  return total === 0
    ? { value: "Free", detail: "No one billed these tokens" }
    : { value: formatUsd(total), detail: "At API prices" };
};

/**
 * One of a provider's figures, laid out as the meters beside it are: its name,
 * its value, and a line under it, with a bar for its share of via's traffic.
 */
function Figure({
  label,
  value,
  detail,
  share,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  /** A percentage; a share that isn't nothing still shows a sliver. */
  readonly share?: number;
}) {
  return (
    <div {...stylex.props(styles.figure)}>
      <dt {...stylex.props(styles.figureLabel)}>{label}</dt>
      <dd {...stylex.props(styles.figureValue)}>{value}</dd>
      <dd {...stylex.props(styles.figureDetail)}>
        {share !== undefined && (
          <span aria-hidden="true" {...stylex.props(styles.shareTrack)}>
            <span
              {...stylex.props(styles.shareFill)}
              style={{ width: share === 0 ? 0 : `max(4px, ${Math.min(100, share)}%)` }}
            />
          </span>
        )}
        <span>{detail}</span>
      </dd>
    </div>
  );
}

/**
 * What via counted of a provider's requests over the last day, as a provider
 * reports no usage of its own: the page's one ask of via beyond what the shell
 * carries, made once the cards are up.
 */
function ProviderCounted({ name }: { readonly name: string }) {
  const now = useNow(60_000);

  const breakdown = useQuery({
    ...historyBreakdownQuery(historyRange(1, "hour", now), "account", {}),
    ...useSignalledOptions(),
  });

  if (breakdown.isPending) return <UsageLoading />;

  if (breakdown.isError) {
    return <p {...stylex.props(styles.muted)}>What via counted couldn't be loaded.</p>;
  }

  const { groups, totals } = breakdown.data;
  const counted = groups.find((group) => group.group === `provider:${name}`);

  if (counted === undefined || counted.requests === 0) {
    return <p {...stylex.props(styles.muted)}>No requests in the last 24 hours.</p>;
  }

  const requests = shareOf(counted.requests, totals.requests);
  const tokens = shareOf(tokensOf(counted), tokensOf(totals));
  const cost = costOf(counted, name);

  return (
    <>
      <dl {...stylex.props(styles.counted)}>
        <Figure
          label="Requests"
          value={formatCount(counted.requests)}
          detail={`Last 24 hours · ${requests.text} of via's requests`}
          share={requests.percent}
        />
        <Figure
          label="Tokens"
          value={formatTokens(tokensOf(counted))}
          detail={`${formatTokens(counted.inputTokens)} in · ${formatTokens(counted.outputTokens)} out`}
          share={tokens.percent}
        />
        <Figure label="Cost" value={cost.value} detail={cost.detail} />
      </dl>
      <Link
        to="/usage"
        search={{ account: `provider:${name}` }}
        {...stylex.props(styles.requestsLink)}
      >
        See its requests
      </Link>
    </>
  );
}

const BUDGET_LABELS = { daily: "Daily budget", weekly: "Weekly budget", monthly: "Monthly budget" };

/**
 * OpenRouter's key budget, as a meter like an account's limit: what it has spent
 * of it, and when it resets. A key without a limit shows none.
 */
function OpenrouterBudget({ usage }: { readonly usage: Usage }) {
  const format = useTimeFormat();
  const mask = useMask();
  const entry = usage.openrouter;

  if (entry === null) return null;

  if ("error" in entry) {
    return (
      <p {...stylex.props(styles.muted)}>
        Budget unavailable: {mask.text(entry.error.replace(/\.$/, ""))}. via asks again on its next
        refresh.
      </p>
    );
  }

  const { budget } = entry;

  if (budget === null) return null;
  const spent = `${formatUsd(budget.spentUsd)} of ${formatUsd(budget.limitUsd)}`;

  return (
    <div {...stylex.props(styles.meters)}>
      <Meter
        label={budget.window === null ? "Budget" : BUDGET_LABELS[budget.window]}
        value={budget.limitUsd === 0 ? 100 : (budget.spentUsd / budget.limitUsd) * 100}
        detail={
          budget.resetsAt === null
            ? `${spent}, never resets`
            : `${spent} · Resets ${formatTime(budget.resetsAt, format)}`
        }
      />
    </div>
  );
}

/**
 * One account or provider: who it is, its state, and its usage windows. Its name
 * is a heading, so heading navigation reaches each; both lines are cut short to
 * fit, and kept whole on hover.
 */
function PoolCard({
  name,
  icon,
  subtitle,
  badge,
  children,
}: {
  readonly name: string;
  readonly icon: ReactNode;
  /** Such as the account's email; the line keeps its place while that is unknown. */
  readonly subtitle: string | undefined;
  readonly badge: ReactNode;
  readonly children: ReactNode;
}) {
  const id = useId();
  const mask = useMask();
  const shownName = mask.key(name);
  const shownSubtitle = subtitle === undefined ? undefined : mask.key(subtitle);

  return (
    <Panel xstyle={styles.card}>
      <article aria-labelledby={id} {...stylex.props(styles.card)}>
        <div {...stylex.props(styles.cardHead)}>
          <div {...stylex.props(styles.identity)}>
            <span aria-hidden="true" {...stylex.props(styles.providerIcon)}>
              {icon}
            </span>
            <div {...stylex.props(styles.who)}>
              <h3 id={id} title={shownName} {...stylex.props(styles.name)}>
                {shownName}
              </h3>
              <span title={shownSubtitle} {...stylex.props(styles.email)}>
                {shownSubtitle ?? " "}
              </span>
            </div>
          </div>
          {badge}
        </div>
        {children}
      </article>
    </Panel>
  );
}

/** Cards shaped like the loaded ones, hidden from assistive tech, which hears the page's status instead. */
function Loading() {
  return (
    <div aria-hidden="true" {...stylex.props(styles.grid)}>
      {[0, 1, 2].map((index) => (
        <Panel key={index} xstyle={styles.card}>
          <div {...stylex.props(styles.skeletonHead)}>
            <Skeleton width="32px" height="32px" />
            <div {...stylex.props(styles.skeletonWho)}>
              <Skeleton width="50%" height="14px" />
              <Skeleton width="70%" height="12px" />
            </div>
          </div>
          <div {...stylex.props(styles.meters)}>
            <Skeleton width="40%" height="12px" />
            <Skeleton height="6px" />
            <Skeleton width="55%" height="12px" />
            <Skeleton height="6px" />
          </div>
        </Panel>
      ))}
    </div>
  );
}

/**
 * When the usage shown was fetched, by its oldest report, ticking; a dot pulses
 * beside it while newer usage is on its way.
 */
function Updated({ usage, fetching }: { readonly usage: Usage; readonly fetching: boolean }) {
  const now = useNow();

  const fetched = [
    ...usage.accounts,
    ...usage.opencodeGo,
    ...(usage.openrouter === null ? [] : [usage.openrouter]),
  ].map(({ fetchedAt }) => Date.parse(fetchedAt));

  return (
    <span {...stylex.props(styles.updated)}>
      <span aria-hidden="true" {...stylex.props(styles.fetching, fetching && styles.fetchingOn)} />
      {fetched.length === 0 ? "Fetching usage…" : `Updated ${ago(now - Math.min(...fetched))}`}
    </span>
  );
}

const title = "Overview";

const description =
  "How the pool stands right now: which accounts and providers via can use, which are resting, and how much of each limit is used.";

/** The page's status region, for a screen reader alone. */
function Status({ children }: { readonly children: string }) {
  return (
    <VisuallyHidden>
      <output aria-live="polite">{children}</output>
    </VisuallyHidden>
  );
}

/** The overview while its data is on its way, which only a page without the shell's state waits for. */
function OverviewLoading() {
  return (
    <Page title={title} description={description}>
      <Status>Loading accounts…</Status>
      <Loading />
    </Page>
  );
}

/** The page when its data couldn't be loaded: its header stays, and it can try again. */
function OverviewError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <Page title={title} description={description}>
      <QueryError
        what="the pool"
        error={error}
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
      />
    </Page>
  );
}

function Overview() {
  const add = useAddAccount();
  // While via pushes the state, nothing here polls.
  const live = useLiveOptions();
  const pool = useSuspenseQuery({ ...poolQuery, ...live });
  const usage = useSuspenseQuery({ ...usageQuery, ...live });
  const accounts = useSuspenseQuery({ ...accountsQuery, ...live });
  const list = pool.data.accounts;
  const opencodeGo = pool.data.opencodeGo;
  const providers = pool.data.providers;
  const everyAccount = [...list, ...opencodeGo];
  const enabled = everyAccount.filter((account) => account.enabled);

  const accountsIn = (status: PoolAccount["state"]["status"]) =>
    enabled.filter((account) => account.state.status === status).length;

  const providersIn = (status: PoolProvider["state"]["status"]) =>
    providers.filter((provider) => provider.state.status === status).length;

  const emailOf = (id: string) => accounts.data.find((account) => account.id === id)?.email;

  const addAccount = (
    <Button onClick={add.open}>
      <PlusIcon size={15} />
      Add account
    </Button>
  );

  return (
    <Page
      title={title}
      description={description}
      actions={everyAccount.length > 0 ? addAccount : undefined}
    >
      <>
        {everyAccount.length === 0 && (
          <EmptyState
            headingLevel={2}
            icon={<AccountsIcon size={18} />}
            title="No accounts yet"
            description="Add a ChatGPT or OpenCode Go account, and via starts pooling it behind one endpoint."
            action={addAccount}
          />
        )}
        {everyAccount.length + providers.length > 0 && (
          <>
            <dl {...stylex.props(styles.stats)}>
              <Stat
                label="Available"
                color="green"
                count={accountsIn("available") + providersIn("available")}
              >
                {" "}
                <span {...stylex.props(styles.statOf)}>
                  of {everyAccount.length + providers.length}
                </span>
              </Stat>
              <Stat
                label="Cooling down or exhausted"
                color="amber"
                count={accountsIn("cooling") + providersIn("exhausted")}
              />
              <Stat
                label="Locked out or unavailable"
                color="red"
                count={accountsIn("auth_error") + providersIn("unavailable")}
              />
              <Stat label="Disabled" color="gray" count={everyAccount.length - enabled.length} />
            </dl>

            <Section
              title="Accounts and providers"
              aside={
                <Updated usage={usage.data} fetching={usage.isFetching || usage.data.refreshing} />
              }
            >
              <div {...stylex.props(styles.grid)}>
                {list.map((account) => (
                  <PoolCard
                    key={`account:${account.id}`}
                    name={account.label}
                    icon={<CodexIcon size={16} />}
                    subtitle={emailOf(account.id)}
                    badge={<AccountBadge account={account} />}
                  >
                    <AccountDetail
                      account={account}
                      locked={{
                        title: `Sign in again: choose Add account and sign in to ${emailOf(account.id) ?? "the same account"}.`,
                        action: (
                          <Button variant="secondary" size="compact" onClick={add.openCodex}>
                            Sign in again
                          </Button>
                        ),
                      }}
                    />
                    <AccountUsage id={account.id} usage={usage.data} />
                  </PoolCard>
                ))}
                {opencodeGo.map((account) => (
                  <PoolCard
                    key={`opencode-go:${account.id}`}
                    name={account.label}
                    icon={<ProviderLogo name="opencode-go" size={16} />}
                    subtitle="OpenCode Go"
                    badge={<AccountBadge account={account} />}
                  >
                    <AccountDetail
                      account={account}
                      locked={{
                        title: "OpenCode Go refused this key.",
                        reason: "Remove the account and add it with a new key.",
                      }}
                    />
                    <OpencodeGoUsage id={account.id} usage={usage.data} />
                  </PoolCard>
                ))}
                {providers.map((provider) => (
                  <PoolCard
                    key={`provider:${provider.name}`}
                    name={providerName(provider.name)}
                    icon={<ProviderLogo name={provider.name} size={16} />}
                    subtitle="Provider"
                    badge={<ProviderBadge provider={provider} />}
                  >
                    <ProviderDetail provider={provider} />
                    {provider.name === "openrouter" && <OpenrouterBudget usage={usage.data} />}
                    <ProviderCounted name={provider.name} />
                  </PoolCard>
                ))}
              </div>
            </Section>
          </>
        )}
      </>
      {add.dialog}
    </Page>
  );
}
