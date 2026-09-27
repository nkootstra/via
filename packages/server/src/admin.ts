import { createHash, timingSafeEqual } from "node:crypto";
import { type Account, AccountNotFoundError, AccountStore } from "@via/codex-auth";
import { KeyStore } from "@via/keys";
import { Providers } from "@via/providers";
import { Clock, Effect, Layer, Redacted, Schema } from "effect";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { accountUsage } from "@via/account-pool";
import { type PoolState, PoolStates } from "@via/pool";
import { AdminApi, AdminAuthorization, Unauthorized } from "./admin-api.ts";
import { ModelCatalog } from "./catalog.ts";
import { Logins } from "./logins.ts";

/** The admin key (`VIA_ADMIN_KEY`) is set, but too short to withstand guessing. */
class AdminKeyTooShortError extends Schema.TaggedError<AdminKeyTooShortError>()(
  "AdminKeyTooShortError",
  { length: Schema.Finite },
) {
  override get message() {
    return `VIA_ADMIN_KEY must be at least 32 characters; it has ${this.length}`;
  }
}

const hash = (key: string) => createHash("sha256").update(key).digest();

const authorization = (adminKey: Redacted.Redacted<string>) => {
  const expected = hash(Redacted.value(adminKey));

  return Layer.succeed(
    AdminAuthorization,
    AdminAuthorization.of({
      // Comparing hashes keeps the comparison constant-time whatever the length.
      bearer: (handler, { credential }) =>
        timingSafeEqual(hash(Redacted.value(credential)), expected)
          ? handler
          : Effect.fail(new Unauthorized({ message: "Missing or invalid admin key" })),
    }),
  );
};

const withoutTokens = ({ id, label, email, plan, enabled, createdAt }: Account) => ({
  id,
  label,
  email,
  plan,
  enabled,
  createdAt,
});

/**
 * The account with id `id`. Unlike the CLI, the admin API doesn't take a label or email:
 * they would end up in URLs, and from there in proxy and access logs.
 */
const byId = Effect.fn("admin.byId")(function* (id: string) {
  const account = (yield* (yield* AccountStore).list).find((a) => a.id === id);

  return account ?? (yield* new AccountNotFoundError({ query: id }));
});

// The account files are via's own; one it can't read or write is a bug, not a request error.
const accounts = HttpApiBuilder.group(AdminApi, "accounts", (handlers) =>
  Effect.gen(function* () {
    // Taken once, so every request sees the same logins.
    const logins = yield* Logins;

    return handlers
      .handle("list", () =>
        Effect.gen(function* () {
          return (yield* (yield* AccountStore).list).map(withoutTokens);
        }).pipe(Effect.orDie),
      )
      .handle("login", () => logins.start())
      .handle("loginStatus", ({ params }) =>
        Effect.map(logins.status(params.id), (login) =>
          login.status === "added"
            ? { status: login.status, account: withoutTokens(login.account) }
            : login,
        ),
      )
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          const store = yield* AccountStore;
          const { id } = yield* byId(params.id);

          if (payload.label !== undefined) yield* store.setLabel(id, payload.label);

          if (payload.enabled !== undefined) yield* store.setEnabled(id, payload.enabled);

          return withoutTokens(yield* store.find(id));
        }).pipe(
          Effect.catchTag(
            ["CorruptFileError", "FileLockTimeoutError", "PlatformError"],
            Effect.die,
          ),
        ),
      )
      .handle("remove", ({ params }) =>
        Effect.gen(function* () {
          yield* (yield* AccountStore).remove((yield* byId(params.id)).id);
        }).pipe(
          Effect.catchTag(
            ["CorruptFileError", "FileLockTimeoutError", "PlatformError"],
            Effect.die,
          ),
        ),
      );
  }),
);

// The key file is via's own; one it can't read or write is a bug, not a request error.
const keys = HttpApiBuilder.group(AdminApi, "keys", (handlers) =>
  handlers
    .handle("list", () => Effect.flatMap(KeyStore, (store) => store.list).pipe(Effect.orDie))
    .handle("create", ({ payload }) =>
      Effect.flatMap(KeyStore, (store) => store.create(payload.name)).pipe(
        Effect.catchTag(["CorruptFileError", "FileLockTimeoutError", "PlatformError"], Effect.die),
      ),
    )
    .handle("revoke", ({ params }) =>
      Effect.flatMap(KeyStore, (store) => store.revoke(params.idOrName)).pipe(
        Effect.catchTag(["CorruptFileError", "FileLockTimeoutError", "PlatformError"], Effect.die),
      ),
    ),
);

/** What ChatGPT says `account` has used, asked live, as `via accounts status` does. */
const reportedUsage = (account: Account) =>
  Effect.gen(function* () {
    const windows = yield* accountUsage(account);

    return {
      id: account.id,
      label: account.label,
      windows: windows.map(({ windowMinutes, usedPercent, resetsAt }) => ({
        windowMinutes,
        usedPercent,
        resetsAt: new Date(resetsAt).toISOString(),
      })),
    };
  }).pipe(
    // One account's usage failing, for whatever reason, doesn't hide the others'.
    Effect.catch((error) =>
      Effect.succeed({ id: account.id, label: account.label, error: error.message }),
    ),
  );

const usage = HttpApiBuilder.group(AdminApi, "usage", (handlers) =>
  handlers.handle("get", () =>
    Effect.gen(function* () {
      const all = yield* (yield* AccountStore).list.pipe(
        // The account files are via's own; one it can't read is a bug, not a request error.
        Effect.orDie,
      );

      // One account at a time, so this never bursts requests at ChatGPT.
      return {
        accounts: yield* Effect.forEach(all, reportedUsage),
        providers: yield* (yield* Providers).usage,
      };
    }),
  ),
);

/** Account `id`'s state in `state` at `now`: a cooldown that has run out counts as available. */
const poolState = (state: PoolState, id: string, now: number) => {
  const current = state[id];

  if (current === undefined || (current.status === "cooling" && current.until <= now))
    return { status: "available" as const };

  return current.status === "cooling"
    ? {
        status: current.status,
        until: new Date(current.until).toISOString(),
        reason: current.reason,
      }
    : current;
};

const pool = HttpApiBuilder.group(AdminApi, "pool", (handlers) =>
  handlers.handle("get", () =>
    Effect.gen(function* () {
      const all = yield* (yield* AccountStore).list.pipe(
        // The account files are via's own; one it can't read is a bug, not a request error.
        Effect.orDie,
      );

      const state = yield* (yield* PoolStates).get;
      const now = yield* Clock.currentTimeMillis;

      return all.map(({ id, label, enabled }) => ({
        id,
        label,
        enabled,
        state: poolState(state, id, now),
      }));
    }),
  ),
);

const models = HttpApiBuilder.group(AdminApi, "models", (handlers) =>
  handlers.handle("list", () => Effect.flatMap(ModelCatalog, (catalog) => catalog.list)),
);

/**
 * The reference page shows the spec and nothing else: system fonts rather than
 * Scalar's web fonts, and no API client or developer toolbar. Effect's
 * `ScalarConfig` type lacks the last two options, but it hands every key to
 * Scalar, whose bundled version supports them.
 */
const scalarConfig = {
  withDefaultFonts: false,
  hideClientButton: true,
  showDeveloperTools: "never",
};

/**
 * The admin API under `/admin`, behind `adminKey` (`VIA_ADMIN_KEY`). Without that
 * key the routes are not registered at all, so `/admin` answers 404 like any unknown
 * path. Its OpenAPI spec and a Scalar reference page for it need no key.
 */
export const adminRoutes = (adminKey: Redacted.Redacted<string> | undefined) =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (adminKey === undefined) return Layer.empty;
      const { length } = Redacted.value(adminKey);

      if (length < 32) return yield* new AdminKeyTooShortError({ length });

      return Layer.merge(
        HttpApiBuilder.layer(AdminApi, { openapiPath: "/admin/openapi.json" }).pipe(
          Layer.provide([accounts, keys, usage, pool, models]),
          Layer.provide([authorization(adminKey), Logins.layer]),
        ),
        // Scalar's script is served inline rather than from a CDN: the page is where
        // the admin key gets typed in, so it runs no third-party code.
        HttpApiScalar.layer(AdminApi, { path: "/admin/docs", scalar: scalarConfig }),
      );
    }),
  );
