import * as stylex from "@stylexjs/stylex";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Badge, Button, EmptyState, Meter, Skeleton } from "@via/ui";
import { colors, fonts, radii, space, text, weights } from "@via/ui/tokens.stylex";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { accountsQuery, poolQuery, usageQuery } from "../../api/admin.ts";
import { AccountsIcon, PlusIcon, ProviderIcon } from "../../components/icons.tsx";
import { Page, Panel, Section } from "../../components/page.tsx";
import { countdown, formatTime, useNow, windowName } from "../../lib/time.ts";
import type { PoolAccount, Usage } from "../../api/types.ts";

export const Route = createFileRoute("/_app/")({
  head: () => ({ meta: [{ title: "Overview · via" }] }),
  component: Overview,
});

const styles = stylex.create({
  stats: {
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
  who: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    minWidth: 0,
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.subtitle,
    fontVariationSettings: weights.semibold,
    color: colors.foreground,
  },
  email: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.caption,
    color: colors.mutedForeground,
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
    marginTop: "auto",
  },
  muted: {
    margin: 0,
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  providerHead: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
  },
  providerIcon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    borderRadius: radii.item,
    backgroundColor: colors.muted,
    color: colors.mutedForeground,
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
    <Panel>
      <div {...stylex.props(styles.stat)}>
        <span {...stylex.props(styles.statLabel)}>
          <span aria-hidden="true" {...stylex.props(styles.dot, stateColors[color])} />
          {label}
        </span>
        <span {...stylex.props(styles.statValue)}>{children}</span>
      </div>
    </Panel>
  );
}

function StateBadge({ account }: { readonly account: PoolAccount }) {
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

function StateDetail({ account }: { readonly account: PoolAccount }) {
  const { state } = account;

  if (!account.enabled || state.status === "available") return null;

  if (state.status === "cooling") {
    return (
      <div {...stylex.props(styles.state, styles.cooling)}>
        <span {...stylex.props(styles.stateTitle)}>
          Back in <Countdown until={state.until} />
        </span>
        <span {...stylex.props(styles.reason)}>
          {state.reason} · until {formatTime(state.until)}
        </span>
      </div>
    );
  }

  return (
    <div {...stylex.props(styles.state, styles.locked)}>
      <span {...stylex.props(styles.stateTitle)}>Sign this account in again</span>
      <span {...stylex.props(styles.reason)}>{state.reason}</span>
    </div>
  );
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

function AccountUsage({
  id,
  usage,
  loading,
}: {
  readonly id: string;
  readonly usage: Usage | undefined;
  readonly loading: boolean;
}) {
  if (loading) {
    return (
      <div {...stylex.props(styles.meters)}>
        <Skeleton width="40%" height="12px" />
        <Skeleton height="6px" />
        <Skeleton width="55%" height="12px" />
        <Skeleton height="6px" />
      </div>
    );
  }

  const entry = usage?.accounts.find((account) => account.id === id);

  if (entry === undefined) return <p {...stylex.props(styles.muted)}>No usage reported yet.</p>;

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

function Overview() {
  const navigate = useNavigate();
  const pool = useQuery(poolQuery);
  const usage = useQuery(usageQuery);
  const accounts = useQuery(accountsQuery);
  const list = pool.data ?? [];
  const enabled = list.filter((account) => account.enabled);

  const count = (status: PoolAccount["state"]["status"]) =>
    enabled.filter((account) => account.state.status === status).length;

  const emailOf = (id: string) => accounts.data?.find((account) => account.id === id)?.email;

  const addAccount = (
    <Button onClick={() => void navigate({ to: "/accounts", search: { add: true } })}>
      <PlusIcon size={15} />
      Add account
    </Button>
  );

  return (
    <Page
      title="Overview"
      description="How the pool stands right now: which accounts via hands out, which are resting, and how much of each limit is used."
      actions={list.length > 0 ? addAccount : undefined}
    >
      {pool.isPending ? (
        <Loading />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<AccountsIcon size={18} />}
          title="No accounts yet"
          description="Add a ChatGPT account and via starts pooling it behind one endpoint."
          action={addAccount}
        />
      ) : (
        <>
          <div {...stylex.props(styles.stats)}>
            <Stat label="Available" color="green">
              {count("available")} <span {...stylex.props(styles.statOf)}>of {list.length}</span>
            </Stat>
            <Stat label="Cooling down" color="amber">
              {count("cooling")}
            </Stat>
            <Stat label="Locked out" color="red">
              {count("auth_error")}
            </Stat>
            <Stat label="Disabled" color="gray">
              {list.length - enabled.length}
            </Stat>
          </div>

          <Section title="Accounts" aside="Refreshes every 5 seconds">
            <div {...stylex.props(styles.grid)}>
              {list.map((account, index) => (
                <motion.div
                  key={account.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: "spring", duration: 0.3, bounce: 0, delay: index * 0.03 }}
                >
                  <Panel xstyle={styles.card}>
                    <article aria-label={account.label} {...stylex.props(styles.card)}>
                      <div {...stylex.props(styles.cardHead)}>
                        <div {...stylex.props(styles.who)}>
                          <span {...stylex.props(styles.name)}>{account.label}</span>
                          <span {...stylex.props(styles.email)}>{emailOf(account.id) ?? " "}</span>
                        </div>
                        <StateBadge account={account} />
                      </div>
                      <StateDetail account={account} />
                      <AccountUsage id={account.id} usage={usage.data} loading={usage.isPending} />
                    </article>
                  </Panel>
                </motion.div>
              ))}
            </div>
          </Section>
        </>
      )}

      <Providers usage={usage.data} loading={usage.isPending} />
    </Page>
  );
}

function Providers({
  usage,
  loading,
}: {
  readonly usage: Usage | undefined;
  readonly loading: boolean;
}) {
  if (loading || usage === undefined || usage.providers.length === 0) return null;

  return (
    <Section title="Providers">
      <div {...stylex.props(styles.grid)}>
        {usage.providers.map((provider) => (
          <Panel key={provider.provider}>
            <article aria-label={provider.provider} {...stylex.props(styles.card)}>
              <div {...stylex.props(styles.providerHead)}>
                <span aria-hidden="true" {...stylex.props(styles.providerIcon)}>
                  <ProviderIcon size={15} />
                </span>
                <span {...stylex.props(styles.name)}>{provider.provider}</span>
              </div>
              {"error" in provider ? (
                <p {...stylex.props(styles.muted)}>Usage unavailable: {provider.error}</p>
              ) : (
                <Windows
                  windows={provider.windows.map((window) => ({
                    label: window.window,
                    usedPercent: window.usedPercent,
                    resetsAt: window.resetsAt,
                  }))}
                />
              )}
            </article>
          </Panel>
        ))}
      </div>
    </Section>
  );
}
