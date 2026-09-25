import { Array, Option } from "effect";

/** Why serve is not using an account right now; absent means it is available. */
export type AccountState =
  | {
      readonly status: "cooling";
      readonly until: number;
      readonly reason: string;
    }
  | { readonly status: "auth_error"; readonly reason: string };

export type PoolState = Readonly<Record<string, AccountState>>;

export type PoolAccount = { readonly id: string; readonly enabled: boolean };

const isAvailable =
  (state: PoolState, now: number) => (account: PoolAccount) => {
    const current = state[account.id];
    return (
      account.enabled &&
      (current === undefined ||
        (current.status === "cooling" && current.until <= now))
    );
  };

/** Fill-first: the first enabled account, in order, that is neither cooling nor locked out. */
export const select = <A extends PoolAccount>(
  accounts: ReadonlyArray<A>,
  state: PoolState,
  now: number,
): Option.Option<A> => Array.findFirst(accounts, isAvailable(state, now));

/** Milliseconds until an enabled account leaves its cooldown; none if waiting will not help. */
export const retryAfter = (
  accounts: ReadonlyArray<PoolAccount>,
  state: PoolState,
  now: number,
): Option.Option<number> => {
  const waits = accounts.flatMap((account) => {
    const current = state[account.id];
    return account.enabled && current?.status === "cooling"
      ? [current.until - now]
      : [];
  });
  return Array.isReadonlyArrayNonEmpty(waits)
    ? Option.some(Math.min(...waits))
    : Option.none();
};
