import * as stylex from "@stylexjs/stylex";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Badge, Button, EmptyState, Meter, Skeleton } from "@via/ui";
import { colors, fonts, radii, space, text, weights } from "@via/ui/tokens.stylex";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { accountsQuery, poolQuery, usageQuery } from "../../api/admin.ts";
import { useLiveOptions } from "../../api/live.ts";
import { useAddAccount } from "../../components/add-account.tsx";
import { AccountsIcon, CodexIcon, PlusIcon, ProviderLogo } from "../../components/icons.tsx";
import { Page, Panel, Section } from "../../components/page.tsx";
import {
  ago,
  countdown,
  formatTime,
  providerWindowName,
  useNow,
  windowName,
} from "../../lib/time.ts";
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
  component: Overview,
});

const styles = stylex.create({
  stats: {
    margin: 0,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
    gap: space.s3,
  },
  stat: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  statLabel: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  statValue: {
    margin: 0,
    fontSize: "26px",
    lineHeight: 1.1,
    letterSpacing: "-0.02em",
    fontVariantNumeric: "tabular-nums",
    fontVariationSettings: weights.semibold,
    color: colors.foreground,
  },
  statOf: {
    fontSize: text.subtitle,
    color: colors.mutedForeground,
    fontVariationSettings: weights.normal,
  },
  dot: {
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
  name: {
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.subtitle,
    fontVariationSettings: weights.semibold,
    color: colors.foreground,
  },
  email: {
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  tag: {
    paddingInline: space.s1_5,
    borderRadius: radii.full,
    fontSize: "11px",
    lineHeight: "17px",
    letterSpacing: "0.02em",
    fontVariationSettings: weights.medium,
    color: colors.mutedForeground,
    boxShadow: `inset 0 0 0 1px ${colors.border}`,
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
  state: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    paddingBlock: space.s2_5,
    paddingInline: space.s3,
    borderRadius: radii.item,
    fontSize: text.caption,
    lineHeight: 1.45,
  },
  cooling: {
    backgroundColor: "color-mix(in oklab, #f59e0b 10%, transparent)",
    boxShadow: "inset 0 0 0 1px color-mix(in oklab, #f59e0b 28%, transparent)",
  },
  locked: {
    backgroundColor: `color-mix(in oklab, ${colors.destructive} 9%, transparent)`,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${colors.destructive} 28%, transparent)`,
  },
  stateTitle: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s2,
    color: colors.foreground,
    fontVariationSettings: weights.medium,
  },
  clock: {
    fontFamily: fonts.mono,
    fontSize: text.body,
    fontVariantNumeric: "tabular-nums",
    fontVariationSettings: weights.semibold,
  },
  reason: { color: colors.mutedForeground },
  meters: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
  },
  muted: {
    margin: 0,
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
    transitionDuration: "200ms",
  },
  fetchingOn: {
    opacity: 1,
    animationName: stylex.keyframes({
      "0%, 100%": { opacity: 1 },
      "50%": { opacity: 0.3 },
    }),
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
});

const stateColors = stylex.create({
  green: { backgroundColor: "#22c55e" },
  amber: { backgroundColor: "#f59e0b" },
  red: { backgroundColor: "#ef4444" },
  gray: { backgroundColor: colors.mutedForeground },
});

/** Time left until `iso`, ticking every second. */
function Countdown({ until }: { readonly until: string }) {
  const left = Date.parse(until) - useNow();

  return <span {...stylex.props(styles.clock)}>{left > 0 ? countdown(left) : "any moment"}</span>;
}

function Stat({
  label,
  color,
  children,
}: {
  readonly label: string;
  readonly color: keyof typeof stateColors;
  readonly children: ReactNode;
}) {
  return (
    <Panel xstyle={styles.stat}>
      <dt {...stylex.props(styles.statLabel)}>
        <span aria-hidden="true" {...stylex.props(styles.dot, stateColors[color])} />
        {label}
      </dt>
      <dd {...stylex.props(styles.statValue)}>{children}</dd>
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
  return (
    <div {...stylex.props(styles.state, styles.cooling)}>
      <span {...stylex.props(styles.stateTitle)}>
        Back in <Countdown until={until} />
      </span>
      <span {...stylex.props(styles.reason)}>{reason}</span>
      <span {...stylex.props(styles.reason)}>
        {ends} {formatTime(until)}
      </span>
    </div>
  );
}

/** A state someone has to fix: what to do, and why. */
function Blocked({ title, reason }: { readonly title: string; readonly reason: string }) {
  return (
    <div {...stylex.props(styles.state, styles.locked)}>
      <span {...stylex.props(styles.stateTitle)}>{title}</span>
      <span {...stylex.props(styles.reason)}>{reason}</span>
    </div>
  );
}

function AccountDetail({
  account,
  locked = "Sign this account in again",
}: {
  readonly account: PoolAccount;
  /** What to do about the account once it is locked out. */
  readonly locked?: string;
}) {
  const { state } = account;

  if (!account.enabled || state.status === "available") return null;

  return state.status === "cooling" ? (
    <Resting until={state.until} reason={state.reason} ends="Ends" />
  ) : (
    <Blocked title={locked} reason={state.reason} />
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
      return <Blocked title="Its usage can't be read" reason={state.reason} />;
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
  return (
    <div {...stylex.props(styles.meters)}>
      {windows.map((window) => (
        <Meter
          key={window.label}
          label={window.label}
          value={window.usedPercent}
          detail={`Resets ${formatTime(window.resetsAt)}`}
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

function AccountUsage({ id, usage }: { readonly id: string; readonly usage: Usage }) {
  const entry = usage.accounts.find((account) => account.id === id);

  // Bars wait only for an account via has no usage for yet, and is fetching.
  if (entry === undefined) {
    return usage.refreshing ? (
      <UsageLoading />
    ) : (
      <p {...stylex.props(styles.muted)}>No usage reported yet.</p>
    );
  }

  if ("error" in entry)
    return <p {...stylex.props(styles.muted)}>Usage unavailable: {entry.error}</p>;

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

  // Bars wait only for an account via has no usage for yet, and is fetching.
  if (entry === undefined) {
    return usage.refreshing ? (
      <UsageLoading />
    ) : (
      <p {...stylex.props(styles.muted)}>No usage reported yet.</p>
    );
  }

  if ("error" in entry)
    return <p {...stylex.props(styles.muted)}>Usage unavailable: {entry.error}</p>;

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

/** One account or provider: who it is, its state, and its usage windows. */
function PoolCard({
  index,
  name,
  icon,
  subtitle,
  badge,
  children,
}: {
  readonly index: number;
  readonly name: string;
  readonly icon: ReactNode;
  readonly subtitle: ReactNode;
  readonly badge: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", duration: 0.3, bounce: 0, delay: index * 0.03 }}
    >
      <Panel xstyle={styles.card}>
        <article aria-label={name} {...stylex.props(styles.card)}>
          <div {...stylex.props(styles.cardHead)}>
            <div {...stylex.props(styles.identity)}>
              <span aria-hidden="true" {...stylex.props(styles.providerIcon)}>
                {icon}
              </span>
              <div {...stylex.props(styles.who)}>
                <span {...stylex.props(styles.name)}>{name}</span>
                {subtitle}
              </div>
            </div>
            {badge}
          </div>
          {children}
        </article>
      </Panel>
    </motion.div>
  );
}

function Loading() {
  return (
    <div {...stylex.props(styles.grid)} aria-busy="true" aria-label="Loading accounts">
      {[0, 1, 2].map((index) => (
        <Panel key={index}>
          <div {...stylex.props(styles.card)}>
            <Skeleton width="50%" height="16px" />
            <Skeleton width="70%" height="12px" />
            <Skeleton height="6px" />
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

/** The overview while its data is on its way, which only a page without the shell's state waits for. */
function OverviewLoading() {
  return (
    <Page title={title} description={description}>
      <Loading />
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
      {everyAccount.length === 0 && (
        <EmptyState
          icon={<AccountsIcon size={18} />}
          title="No accounts yet"
          description="Add a ChatGPT account or an OpenCode Go key, and via starts pooling it behind one endpoint."
          action={addAccount}
        />
      )}
      {everyAccount.length + providers.length > 0 && (
        <>
          <dl {...stylex.props(styles.stats)}>
            <Stat label="Available" color="green">
              {accountsIn("available") + providersIn("available")}{" "}
              <span {...stylex.props(styles.statOf)}>
                of {everyAccount.length + providers.length}
              </span>
            </Stat>
            <Stat label="Resting" color="amber">
              {accountsIn("cooling") + providersIn("exhausted")}
            </Stat>
            <Stat label="Needs attention" color="red">
              {accountsIn("auth_error") + providersIn("unavailable")}
            </Stat>
            <Stat label="Disabled" color="gray">
              {everyAccount.length - enabled.length}
            </Stat>
          </dl>

          <Section
            title="Accounts and providers"
            aside={
              <Updated usage={usage.data} fetching={usage.isFetching || usage.data.refreshing} />
            }
          >
            <div {...stylex.props(styles.grid)}>
              {list.map((account, index) => (
                <PoolCard
                  key={`account:${account.id}`}
                  index={index}
                  name={account.label}
                  icon={<CodexIcon size={16} />}
                  subtitle={
                    <span {...stylex.props(styles.email)}>{emailOf(account.id) ?? " "}</span>
                  }
                  badge={<AccountBadge account={account} />}
                >
                  <AccountDetail account={account} />
                  <AccountUsage id={account.id} usage={usage.data} />
                </PoolCard>
              ))}
              {opencodeGo.map((account, index) => (
                <PoolCard
                  key={`opencode-go:${account.id}`}
                  index={list.length + index}
                  name={account.label}
                  icon={<ProviderLogo name="opencode-go" size={16} />}
                  subtitle={<span {...stylex.props(styles.tag)}>OpenCode Go</span>}
                  badge={<AccountBadge account={account} />}
                >
                  <AccountDetail account={account} locked="OpenCode Go refused its key" />
                  <OpencodeGoUsage id={account.id} usage={usage.data} />
                </PoolCard>
              ))}
              {providers.map((provider, index) => (
                <PoolCard
                  key={`provider:${provider.name}`}
                  index={everyAccount.length + index}
                  name={providerName(provider.name)}
                  icon={<ProviderLogo name={provider.name} size={16} />}
                  subtitle={<span {...stylex.props(styles.tag)}>Provider</span>}
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
      {add.dialog}
    </Page>
  );
}
