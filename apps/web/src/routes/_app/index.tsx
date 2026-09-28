import * as stylex from "@stylexjs/stylex";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { Badge, Button, Callout, EmptyState, Meter, Skeleton, VisuallyHidden } from "@via/ui";
import { colors, durations, radii, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { useId, type ReactNode } from "react";
import { accountsQuery, poolQuery, usageQuery } from "../../api/admin.ts";
import { useLiveOptions } from "../../api/live.ts";
import { useAddAccount } from "../../components/add-account.tsx";
import { AccountsIcon, CodexIcon, PlusIcon, ProviderLogo } from "../../components/icons.tsx";
import { Page, Panel, Section } from "../../components/page.tsx";
import { QueryError } from "../../components/query-error.tsx";
import {
  ago,
  countdown,
  formatTime,
  providerWindowName,
  useNow,
  windowName,
} from "../../lib/time.ts";
import { useTimeFormat } from "../../lib/time-format.ts";
import { providerName } from "../../lib/provider-name.ts";
import type { PoolAccount, PoolProvider, Usage } from "../../api/types.ts";

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
  clock: {
    fontSize: text.body,
    fontVariantNumeric: "tabular-nums",
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
  },
  reason: { color: colors.mutedForeground },
  fix: { marginTop: space.s1 },
  meters: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
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

/** When a resting state ends: the time left until `until`, ticking every second. */
function BackIn({ until }: { readonly until: string }) {
  const left = Date.parse(until) - useNow();

  return left > 0 ? (
    <>
      Back in <span {...stylex.props(styles.clock)}>{countdown(left)}</span>
    </>
  ) : (
    "Back any moment"
  );
}

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

  return (
    <Callout tone="warning">
      <div {...stylex.props(styles.state)}>
        <span {...stylex.props(styles.stateTitle)}>
          <BackIn until={until} />
        </span>
        <span {...stylex.props(styles.reason)}>{reason}</span>
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
  return (
    <Callout tone="danger">
      <div {...stylex.props(styles.state)}>
        <span {...stylex.props(styles.stateTitle)}>{title}</span>
        <span {...stylex.props(styles.reason)}>{reason}</span>
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
    <Resting until={state.until} reason={state.reason} ends="Ends" />
  ) : (
    <Blocked
      title={locked.title}
      reason={locked.reason ?? state.reason}
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
  const reason = error.replace(/^[\w-]+/, providerName).replace(/\.$/, "");

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

  return (
    <Panel xstyle={styles.card}>
      <article aria-labelledby={id} {...stylex.props(styles.card)}>
        <div {...stylex.props(styles.cardHead)}>
          <div {...stylex.props(styles.identity)}>
            <span aria-hidden="true" {...stylex.props(styles.providerIcon)}>
              {icon}
            </span>
            <div {...stylex.props(styles.who)}>
              <h3 id={id} title={name} {...stylex.props(styles.name)}>
                {name}
              </h3>
              <span title={subtitle} {...stylex.props(styles.email)}>
                {subtitle ?? " "}
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

  const fetched = [...usage.accounts, ...usage.opencodeGo].map(({ fetchedAt }) =>
    Date.parse(fetchedAt),
  );

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
                    <p {...stylex.props(styles.muted)}>This provider doesn't report usage.</p>
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
