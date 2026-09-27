import { createHash, timingSafeEqual } from "node:crypto";
import { type Account, AccountStore, AccountTokens } from "@via/codex-auth";
import { CodexUpstream } from "@via/codex-upstream";
import { DuplicateKeyNameError, KeyNotFoundError, KeyStore } from "@via/keys";
import { Providers } from "@via/providers";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/unstable/httpapi";

/** An account as the admin API shows it: everything but its tokens. */
const AdminAccount = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  email: Schema.String,
  plan: Schema.String,
  enabled: Schema.Boolean,
  createdAt: Schema.String,
});

/** A client API key as the admin API lists it: never the key itself. */
const AdminKey = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
});

/** A newly created client API key; the only time the key is shown. */
const CreatedKey = Schema.Struct({ id: Schema.String, name: Schema.String, key: Schema.String });

/** An account's rate limit windows, or why ChatGPT did not report them. */
const AccountUsage = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    windows: Schema.Array(
      Schema.Struct({
        windowMinutes: Schema.Number,
        usedPercent: Schema.Number,
        resetsAt: Schema.String,
      }),
    ),
  }),
  Schema.Struct({ id: Schema.String, label: Schema.String, error: Schema.String }),
]);

/** A provider's usage windows, such as OpenCode Go's, or why it did not report them. */
const ProviderUsage = Schema.Union([
  Schema.Struct({
    provider: Schema.String,
    windows: Schema.Array(
      Schema.Struct({
        window: Schema.String,
        status: Schema.String,
        usedPercent: Schema.Number,
        resetsAt: Schema.String,
      }),
    ),
  }),
  Schema.Struct({ provider: Schema.String, error: Schema.String }),
]);

const Usage = Schema.Struct({
  accounts: Schema.Array(AccountUsage),
  providers: Schema.Array(ProviderUsage),
});

class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

/** Lets a request through only with `Authorization: Bearer <VIA_ADMIN_KEY>`. */
class AdminAuthorization extends HttpApiMiddleware.Service<AdminAuthorization>()(
  "via/AdminAuthorization",
  { security: { bearer: HttpApiSecurity.bearer }, error: Unauthorized },
) {}

class AccountsGroup extends HttpApiGroup.make("accounts")
  .add(HttpApiEndpoint.get("list", "/accounts", { success: Schema.Array(AdminAccount) }))
  .middleware(AdminAuthorization)
  .prefix("/admin") {}

class KeysGroup extends HttpApiGroup.make("keys")
  .add(HttpApiEndpoint.get("list", "/keys", { success: Schema.Array(AdminKey) }))
  .add(
    HttpApiEndpoint.post("create", "/keys", {
      // A plain fields object would make this a form body; a Struct makes it JSON.
      payload: Schema.Struct({ name: Schema.String }),
      success: CreatedKey.pipe(HttpApiSchema.status(201)),
      error: DuplicateKeyNameError.pipe(HttpApiSchema.status(409)),
    }),
  )
  .add(
    HttpApiEndpoint.delete("revoke", "/keys/:idOrName", {
      params: { idOrName: Schema.String },
      error: KeyNotFoundError.pipe(HttpApiSchema.status(404)),
    }),
  )
  .middleware(AdminAuthorization)
  .prefix("/admin") {}

class UsageGroup extends HttpApiGroup.make("usage")
  .add(HttpApiEndpoint.get("get", "/usage", { success: Usage }))
  .middleware(AdminAuthorization)
  .prefix("/admin") {}

class AdminApi extends HttpApi.make("via-admin")
  .add(AccountsGroup)
  .add(KeysGroup)
  .add(UsageGroup) {}

/** `VIA_ADMIN_KEY` is set, but too short to withstand guessing. */
class AdminKeyTooShortError extends Schema.TaggedError<AdminKeyTooShortError>()(
  "AdminKeyTooShortError",
  { length: Schema.Number },
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

const accounts = HttpApiBuilder.group(AdminApi, "accounts", (handlers) =>
  handlers.handle("list", () =>
    Effect.gen(function* () {
      const all = yield* (yield* AccountStore).list;
      return all.map(({ id, label, email, plan, enabled, createdAt }) => ({
        id,
        label,
        email,
        plan,
        enabled,
        createdAt,
      }));
    }).pipe(
      // The account files are via's own; one it can't read is a bug, not a request error.
      Effect.orDie,
    ),
  ),
);

// The key file is via's own; one it can't read or write is a bug, not a request error.
const keys = HttpApiBuilder.group(AdminApi, "keys", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        return yield* (yield* KeyStore).list;
      }).pipe(Effect.orDie),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        return yield* (yield* KeyStore).create(payload.name);
      }).pipe(Effect.catchTag(["CorruptFileError", "PlatformError"], Effect.die)),
    )
    .handle("revoke", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* KeyStore).revoke(params.idOrName);
      }).pipe(Effect.catchTag(["CorruptFileError", "PlatformError"], Effect.die)),
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
 * The admin API under `/admin`, behind `VIA_ADMIN_KEY`. Without that key the
 * routes are not registered at all, so `/admin` answers 404 like any unknown path.
 */
export const adminRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const adminKey = yield* Config.option(Config.Redacted("VIA_ADMIN_KEY"));
    if (Option.isNone(adminKey)) return Layer.empty;
    const { length } = Redacted.value(adminKey.value);
    if (length < 32) return yield* new AdminKeyTooShortError({ length });
    return HttpApiBuilder.layer(AdminApi).pipe(
      Layer.provide([accounts, keys, usage]),
      Layer.provide(authorization(adminKey.value)),
    );
  }),
);
