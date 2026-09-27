import { createHash, timingSafeEqual } from "node:crypto";
import { type Account, AccountNotFoundError, AccountStore, AccountTokens } from "@via/codex-auth";
import { CodexUpstream } from "@via/codex-upstream";
import { KeyStore } from "@via/keys";
import { Providers } from "@via/providers";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { AdminApi, AdminAuthorization, Unauthorized } from "./admin-api.ts";
import { Logins } from "./logins.ts";

/** `VIA_ADMIN_KEY` is set, but too short to withstand guessing. */
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
        }).pipe(Effect.catchTag(["CorruptFileError", "PlatformError"], Effect.die)),
      )
      .handle("remove", ({ params }) =>
        Effect.gen(function* () {
          yield* (yield* AccountStore).remove((yield* byId(params.id)).id);
        }).pipe(Effect.catchTag(["CorruptFileError", "PlatformError"], Effect.die)),
      );
  }),
);

// The key file is via's own; one it can't read or write is a bug, not a request error.
const keys = HttpApiBuilder.group(AdminApi, "keys", (handlers) =>
  handlers
    .handle("list", () => Effect.flatMap(KeyStore, (store) => store.list).pipe(Effect.orDie))
    .handle("create", ({ payload }) =>
      Effect.flatMap(KeyStore, (store) => store.create(payload.name)).pipe(
        Effect.catchTag(["CorruptFileError", "PlatformError"], Effect.die),
      ),
    )
    .handle("revoke", ({ params }) =>
      Effect.flatMap(KeyStore, (store) => store.revoke(params.idOrName)).pipe(
        Effect.catchTag(["CorruptFileError", "PlatformError"], Effect.die),
      ),
    ),
);

/** What ChatGPT says `account` has used, asked live, as `via accounts status` does. */
const accountUsage = (account: Account) =>
  Effect.gen(function* () {
    const fresh = yield* (yield* AccountTokens).fresh(account);
    const windows = yield* (yield* CodexUpstream).usage(fresh);

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
        accounts: yield* Effect.forEach(all, accountUsage),
        providers: yield* (yield* Providers).usage,
      };
    }),
  ),
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
 * The admin API under `/admin`, behind `VIA_ADMIN_KEY`. Without that key the
 * routes are not registered at all, so `/admin` answers 404 like any unknown path.
 * Its OpenAPI spec and a Scalar reference page for it need no key.
 */
export const adminRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const adminKey = yield* Config.option(Config.Redacted("VIA_ADMIN_KEY"));

    if (Option.isNone(adminKey)) return Layer.empty;
    const { length } = Redacted.value(adminKey.value);

    if (length < 32) return yield* new AdminKeyTooShortError({ length });

    return Layer.merge(
      HttpApiBuilder.layer(AdminApi, { openapiPath: "/admin/openapi.json" }).pipe(
        Layer.provide([accounts, keys, usage]),
        Layer.provide([authorization(adminKey.value), Logins.layer]),
      ),
      // Scalar's script is served inline rather than from a CDN: the page is where
      // the admin key gets typed in, so it runs no third-party code.
      HttpApiScalar.layer(AdminApi, { path: "/admin/docs", scalar: scalarConfig }),
    );
  }),
);
