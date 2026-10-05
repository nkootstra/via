// How each fallback rule stands now: whether its model and each of its fallbacks
// could serve a request, and which would. It only looks: no token is refreshed and
// no upstream is asked, so outages show only once a request meets them.
import { AccountStore } from "@via/codex-auth";
import { type FallbackRule, FallbackRuleStore } from "@via/fallbacks";
import { available, type PoolAccount, type PoolState, PoolStates } from "@via/pool";
import { OpencodeGoAccounts, Providers } from "@via/providers";
import { Clock, Effect, Option } from "effect";
import { ModelCatalog } from "./catalog.ts";
import { isListed } from "./fallback.ts";

/** Whether a model could serve a request now, and if not, why and until when. */
type Availability =
  | { readonly status: "available" }
  | { readonly status: "cooling"; readonly until: string; readonly reason: string }
  | {
      readonly status: "unavailable";
      readonly reason: "no_accounts" | "not_enabled" | "not_listed";
    };

/**
 * How `accounts` stand together at `now`: available while one is, else cooling
 * until the first cooldown among them ends, else none can serve.
 */
const availabilityAmong = (
  accounts: ReadonlyArray<PoolAccount>,
  state: PoolState,
  now: number,
): Availability => {
  if (available(accounts, state, now).length > 0) return { status: "available" };

  const soonest = accounts
    .flatMap((account) => {
      const current = state[account.id];

      return account.enabled && current?.status === "cooling" ? [current] : [];
    })
    .reduce<{ readonly until: number; readonly reason: string } | undefined>(
      (first, cooling) => (first === undefined || cooling.until < first.until ? cooling : first),
      undefined,
    );

  return soonest === undefined
    ? { status: "unavailable", reason: "no_accounts" }
    : { status: "cooling", until: new Date(soonest.until).toISOString(), reason: soonest.reason };
};

// The account files are via's own; one it can't read is a bug, not a request error.
const codexAccounts = Effect.flatMap(AccountStore, (store) => store.list).pipe(Effect.orDie);

const goAccounts = Effect.flatMap(OpencodeGoAccounts, (store) => store.list).pipe(Effect.orDie);

/**
 * Whether `model` could serve a request now: a provider's that isn't enabled
 * can't, nor a model via doesn't know; OpenCode Go's and Codex's can while one
 * of the accounts that may serve it can; any other provider's is taken to.
 */
const availabilityOf = Effect.fn("availabilityOf")(function* (model: string) {
  const route = (yield* Providers).route(model);
  const state = yield* (yield* PoolStates).get;
  const now = yield* Clock.currentTimeMillis;

  if (Option.isSome(route)) {
    if (route.value.disabled === true) {
      return { status: "unavailable", reason: "not_enabled" } satisfies Availability;
    }

    return route.value.pooled
      ? availabilityAmong(yield* goAccounts, state, now)
      : ({ status: "available" } satisfies Availability);
  }

  if (!(yield* isListed(model))) {
    return { status: "unavailable", reason: "not_listed" } satisfies Availability;
  }

  const allowed = yield* (yield* ModelCatalog).mayServe(model);

  return availabilityAmong(
    (yield* codexAccounts).filter((account) => allowed(account.id)),
    state,
    now,
  );
});

/** `rule` as the admin API shows it: with how its model and fallbacks stand, and which would serve. */
export const withStatus = Effect.fn("withStatus")(function* (rule: FallbackRule) {
  const source = yield* availabilityOf(rule.model);
  const fallbacks = yield* Effect.forEach(rule.fallbacks, availabilityOf);
  const first = rule.fallbacks.find((_, index) => fallbacks[index]?.status === "available");

  return {
    model: rule.model,
    fallbacks: rule.fallbacks,
    status: {
      source,
      fallbacks,
      serving: source.status === "available" ? rule.model : (first ?? null),
    },
  };
});

/**
 * Every rule with its status, and why the rules can't be read when they can't: then there
 * are none, as for a request, which falls back to nothing until the file is fixed.
 */
export const fallbacksNow = Effect.flatMap(FallbackRuleStore, (store) => store.list).pipe(
  Effect.flatMap((rules) =>
    Effect.map(Effect.forEach(rules, withStatus), (fallbacks) => ({
      fallbacks,
      fallbacksError: null,
    })),
  ),
  Effect.catchTag(["CorruptFileError", "PlatformError"], (error) =>
    Effect.succeed({ fallbacks: [], fallbacksError: error.message }),
  ),
);
