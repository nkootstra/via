// What the admin API shows of via's services: the pool, the usage, the accounts and
// the keys, as its contract types them. Its routes answer from here, and so does
// the admin state that a signed-in page's shell embeds and `GET /admin/events` sends.
import { UsageSnapshots } from "@via/account-pool";
import { type Account, AccountStore } from "@via/codex-auth";
import { KeyStore } from "@via/keys";
import { type PoolState, PoolStates } from "@via/pool";
import {
  maskKey,
  type OpencodeGoAccount,
  OpencodeGoAccounts,
  Providers,
  providerState,
} from "@via/providers";
import { Clock, Effect, Option, Redacted } from "effect";
import type { AdminState } from "./admin-api.ts";
import { ModelCatalog } from "./catalog.ts";

export const withoutTokens = ({ id, label, email, plan, enabled, createdAt }: Account) => ({
  id,
  label,
  email,
  plan,
  enabled,
  createdAt,
});

/** The deprecated environment variable OpenCode Go's key is read from, and its key, while it is set. */
export type OpencodeGoEnvironment = {
  readonly variable: string;
  readonly apiKey: Redacted.Redacted<string>;
};

/**
 * `account` as the admin API shows it: its key masked, and the variable it came
 * from while `environment` still has it.
 */
export const opencodeGoAccount = (
  account: OpencodeGoAccount,
  environment: OpencodeGoEnvironment | undefined,
) => {
  const { id, label, apiKey, enabled, createdAt } = account;
  const shown = { id, label, key: maskKey(apiKey), enabled, createdAt };

  return environment !== undefined && Redacted.value(environment.apiKey) === Redacted.value(apiKey)
    ? { ...shown, environmentVariable: environment.variable }
    : shown;
};

const iso = (millis: number) => new Date(millis).toISOString();

/**
 * The latest usage via has, answered at once: the usage poll and a snapshot a
 * minute old or missing refresh it in the background.
 */
const latestUsage = Effect.flatMap(UsageSnapshots, (snapshots) => snapshots.latest).pipe(
  // The account files are via's own; one it can't read is a bug, not a request error.
  Effect.orDie,
);

type LatestUsage = Effect.Success<typeof latestUsage>;

// The account and key files are via's own; one it can't read is a bug, not a request error.
const accounts = Effect.flatMap(AccountStore, (store) => store.list).pipe(Effect.orDie);

const goAccounts = Effect.flatMap(OpencodeGoAccounts, (store) => store.list).pipe(Effect.orDie);

const keys = Effect.flatMap(KeyStore, (store) => store.list).pipe(Effect.orDie);

const usageOf = (latest: LatestUsage) => ({
  accounts: latest.accounts.map((entry) => {
    const { id, label } = entry.account;
    const fetchedAt = iso(entry.fetchedAt);

    return "error" in entry
      ? { id, label, fetchedAt, error: entry.error }
      : {
          id,
          label,
          fetchedAt,
          windows: entry.windows.map(({ windowMinutes, usedPercent, resetsAt }) => ({
            windowMinutes,
            usedPercent,
            resetsAt: iso(resetsAt),
          })),
        };
  }),
  opencodeGo: latest.opencodeGo.map((entry) => {
    const { id, label } = entry.account;
    const fetchedAt = iso(entry.fetchedAt);

    return "error" in entry
      ? { id, label, fetchedAt, error: entry.error }
      : { id, label, fetchedAt, windows: entry.windows };
  }),
  refreshing: latest.refreshing,
});

/** Account `id`'s state in `state` at `now`: a cooldown that has run out counts as available. */
const poolState = (state: PoolState, id: string, now: number) => {
  const current = state[id];

  if (current === undefined || (current.status === "cooling" && current.until <= now))
    return { status: "available" as const };

  return current.status === "cooling"
    ? { status: current.status, until: iso(current.until), reason: current.reason }
    : current;
};

type InPool = { readonly id: string; readonly label: string; readonly enabled: boolean };

const poolOf = Effect.fn("admin.pool")(function* (
  listed: ReadonlyArray<InPool>,
  listedGo: ReadonlyArray<InPool>,
) {
  const names = yield* (yield* Providers).names;
  const state = yield* (yield* PoolStates).get;
  const now = yield* Clock.currentTimeMillis;

  const inPool = ({ id, label, enabled }: InPool) => ({
    id,
    label,
    enabled,
    state: poolState(state, id, now),
  });

  return {
    accounts: listed.map(inPool),
    opencodeGo: listedGo.map(inPool),
    // A provider with its own key reports no usage, so it is always there to try.
    providers: names.map((name) => ({ name, state: providerState(undefined, now) })),
  };
});

/** The accounts, without their tokens, as `GET /admin/accounts` answers them. */
export const adminAccounts = Effect.map(accounts, (listed) => listed.map(withoutTokens));

/** The latest usage, as `GET /admin/usage` answers it. */
export const adminUsage = Effect.map(latestUsage, usageOf);

/** Every account's and provider's state, as `GET /admin/pool` answers it. */
export const adminPool = Effect.gen(function* () {
  return yield* poolOf(yield* accounts, yield* goAccounts);
});

/** The OpenCode Go accounts, keys masked, as `GET /admin/opencode-go/accounts` answers them. */
export const adminOpencodeGo = (environment: OpencodeGoEnvironment | undefined) =>
  Effect.map(goAccounts, (listed) =>
    listed.map((account) => opencodeGoAccount(account, environment)),
  );

/** What the admin state says beyond what via's services hold. */
export type StateOptions = {
  readonly environment: OpencodeGoEnvironment | undefined;
  /** The running via's version, the CLI's. */
  readonly version: string;
};

/** Where Ollama is, as `GET /admin/ollama` answers it. */
export const adminOllama = Effect.flatMap(Providers, ({ ollama }) =>
  Effect.map(ollama.get, Option.getOrNull),
);

/** The admin state now: what the routes above answer, the keys and the models, all at once. */
export const adminState = ({ environment, version }: StateOptions) =>
  Effect.gen(function* () {
    const listed = yield* accounts;
    const listedGo = yield* goAccounts;

    return {
      session: true,
      version,
      pool: yield* poolOf(listed, listedGo),
      usage: usageOf(yield* latestUsage),
      accounts: listed.map(withoutTokens),
      opencodeGo: listedGo.map((account) => opencodeGoAccount(account, environment)),
      keys: yield* keys,
      models: yield* (yield* ModelCatalog).list,
      ollama: yield* adminOllama,
    } satisfies typeof AdminState.Type;
  });
