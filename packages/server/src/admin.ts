import { type Account, AccountNotFoundError, AccountStore } from "@via/codex-auth";
import { KeyStore } from "@via/keys";
import {
  maskKey,
  type OpencodeGoAccount,
  OpencodeGoAccountNotFoundError,
  OpencodeGoAccounts,
  Providers,
  providerState,
} from "@via/providers";
import { Clock, type Duration, Effect, Layer, Redacted, Schema } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { UsageSnapshots } from "@via/account-pool";
import { type PoolState, PoolStates } from "@via/pool";
import { AdminApi, AdminAuthorization, Forbidden, session, Unauthorized } from "./admin-api.ts";
import { AdminSessions, SESSION_LIFETIME } from "./admin-sessions.ts";
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

/** A browser's `Origin` header, when it names an http(s) origin. */
const originOf = (request: HttpServerRequest.HttpServerRequest) => {
  const origin = URL.parse(request.headers.origin ?? "");

  return origin !== null && (origin.protocol === "http:" || origin.protocol === "https:")
    ? origin
    : undefined;
};

/**
 * Whether a request that only has a session cookie comes from via's own page, and
 * so may change something. A browser sets `Origin` itself, and a cross-site form
 * can't add `x-via-csrf`. The origin's scheme isn't compared: behind a proxy that
 * ends TLS, via sees plain HTTP while the browser says `https`.
 */
const fromOwnPage = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers["x-via-csrf"] === "1" && originOf(request)?.host === request.headers.host;

/** Methods that only read, which need no check for a forged request. */
const reads = new Set(["GET", "HEAD"]);

const invalid = new Unauthorized({ message: "Missing or invalid admin key or session" });

const authorization = Layer.effect(
  AdminAuthorization,
  Effect.gen(function* () {
    const sessions = yield* AdminSessions;

    return AdminAuthorization.of({
      bearer: (handler, { credential }) =>
        Effect.gen(function* () {
          if (!(yield* sessions.isAdminKey(credential))) return yield* invalid;

          return yield* handler;
        }),
      session: (handler, { credential }) =>
        Effect.gen(function* () {
          if (!(yield* sessions.verify(credential))) return yield* invalid;
          const request = yield* HttpServerRequest.HttpServerRequest;

          if (!reads.has(request.method) && !fromOwnPage(request)) {
            return yield* new Forbidden({
              message: "A change signed in with a session must come from via's own page",
            });
          }

          return yield* handler;
        }),
    });
  }),
);

/**
 * Sets the session cookie to `token`. It is `Secure` when the browser signed in
 * over HTTPS, which its `Origin` says even behind a proxy that ends TLS.
 */
const setSessionCookie = (token: Redacted.Redacted<string> | "", maxAge: Duration.Input) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    yield* HttpApiBuilder.securitySetCookie(session, token, {
      httpOnly: true,
      secure: originOf(request)?.protocol === "https:",
      sameSite: "strict",
      path: "/admin",
      maxAge,
    });
  });

const sessions = HttpApiBuilder.group(AdminApi, "session", (handlers) =>
  Effect.gen(function* () {
    const admin = yield* AdminSessions;

    return handlers
      .handle("signIn", ({ payload }) =>
        Effect.flatMap(admin.signIn(payload.key), (token) =>
          setSessionCookie(token, SESSION_LIFETIME),
        ),
      )
      .handle("get", () => Effect.void)
      .handle("signOut", () =>
        Effect.gen(function* () {
          const token = (yield* HttpServerRequest.HttpServerRequest).cookies[session.key];

          if (token !== undefined) yield* admin.signOut(Redacted.make(token));
          yield* setSessionCookie("", 0);
        }),
      );
  }),
);

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

/** The deprecated environment variable OpenCode Go's key is read from, and its key, while it is set. */
export type OpencodeGoEnvironment = {
  readonly variable: string;
  readonly apiKey: Redacted.Redacted<string>;
};

/**
 * `account` as the admin API shows it: its key masked, and the variable it came
 * from while `environment` still has it.
 */
const opencodeGoAccount = (
  account: OpencodeGoAccount,
  environment: OpencodeGoEnvironment | undefined,
) => {
  const { id, label, apiKey, enabled, createdAt } = account;
  const shown = { id, label, key: maskKey(apiKey), enabled, createdAt };

  return environment !== undefined && Redacted.value(environment.apiKey) === Redacted.value(apiKey)
    ? { ...shown, environmentVariable: environment.variable }
    : shown;
};

/** The OpenCode Go account with id `id`; like the ChatGPT accounts, never by label. */
const opencodeGoById = Effect.fn("admin.opencodeGoById")(function* (id: string) {
  const account = (yield* (yield* OpencodeGoAccounts).list).find((a) => a.id === id);

  return account ?? (yield* new OpencodeGoAccountNotFoundError({ query: id }));
});

// The account file is via's own; one it can't read or write is a bug, not a request error.
const opencodeGo = (environment: OpencodeGoEnvironment | undefined) =>
  HttpApiBuilder.group(AdminApi, "opencodeGo", (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const all = yield* (yield* OpencodeGoAccounts).list;

          return all.map((account) => opencodeGoAccount(account, environment));
        }).pipe(Effect.orDie),
      )
      .handle("add", ({ payload }) =>
        Effect.gen(function* () {
          // Checked first, so a mistyped key is never stored.
          yield* (yield* Providers).verify(payload.apiKey);
          const added = yield* (yield* OpencodeGoAccounts).add(payload.apiKey, payload.label);

          return opencodeGoAccount(added, environment);
        }).pipe(
          Effect.catchTag(
            ["CorruptFileError", "FileLockTimeoutError", "PlatformError"],
            Effect.die,
          ),
        ),
      )
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          const store = yield* OpencodeGoAccounts;
          const { id } = yield* opencodeGoById(params.id);

          if (payload.label !== undefined) yield* store.setLabel(id, payload.label);

          if (payload.enabled !== undefined) yield* store.setEnabled(id, payload.enabled);

          return opencodeGoAccount(yield* store.find(id), environment);
        }).pipe(
          Effect.catchTag(
            ["CorruptFileError", "FileLockTimeoutError", "PlatformError"],
            Effect.die,
          ),
        ),
      )
      .handle("remove", ({ params }) =>
        Effect.gen(function* () {
          yield* (yield* OpencodeGoAccounts).remove((yield* opencodeGoById(params.id)).id);
        }).pipe(
          Effect.catchTag(
            ["CorruptFileError", "FileLockTimeoutError", "PlatformError"],
            Effect.die,
          ),
        ),
      ),
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

const iso = (millis: number) => new Date(millis).toISOString();

/**
 * The latest usage via has, answered at once: the usage poll and a snapshot a
 * minute old or missing refresh it in the background.
 */
const latestUsage = Effect.flatMap(UsageSnapshots, (snapshots) => snapshots.latest).pipe(
  // The account files are via's own; one it can't read is a bug, not a request error.
  Effect.orDie,
);

const usage = HttpApiBuilder.group(AdminApi, "usage", (handlers) =>
  handlers.handle("get", () =>
    Effect.gen(function* () {
      const latest = yield* latestUsage;

      return {
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
  Effect.gen(function* () {
    const providers = yield* Providers;

    return handlers.handle("get", () =>
      Effect.gen(function* () {
        // The account files are via's own; one it can't read is a bug, not a request error.
        const all = yield* Effect.orDie((yield* AccountStore).list);
        const goAccounts = yield* Effect.orDie((yield* OpencodeGoAccounts).list);
        const state = yield* (yield* PoolStates).get;
        const now = yield* Clock.currentTimeMillis;

        const inPool = ({
          id,
          label,
          enabled,
        }: {
          id: string;
          label: string;
          enabled: boolean;
        }) => ({
          id,
          label,
          enabled,
          state: poolState(state, id, now),
        });

        return {
          accounts: all.map(inPool),
          opencodeGo: goAccounts.map(inPool),
          // A provider with its own key reports no usage, so it is always there to try.
          providers: providers.names.map((name) => ({
            name,
            state: providerState(undefined, now),
          })),
        };
      }),
    );
  }),
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
export const adminRoutes = (
  adminKey: Redacted.Redacted<string> | undefined,
  opencodeGoEnvironment?: OpencodeGoEnvironment,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (adminKey === undefined) return Layer.empty;
      const { length } = Redacted.value(adminKey);

      if (length < 32) return yield* new AdminKeyTooShortError({ length });

      return Layer.merge(
        HttpApiBuilder.layer(AdminApi, { openapiPath: "/admin/openapi.json" }).pipe(
          Layer.provide([
            sessions,
            accounts,
            opencodeGo(opencodeGoEnvironment),
            keys,
            usage,
            pool,
            models,
          ]),
          Layer.provide([authorization, Logins.layer]),
          Layer.provide(AdminSessions.layer(adminKey)),
        ),
        // Scalar's script is served inline rather than from a CDN: the page is where
        // the admin key gets typed in, so it runs no third-party code.
        HttpApiScalar.layer(AdminApi, { path: "/admin/docs", scalar: scalarConfig }),
      );
    }),
  );
