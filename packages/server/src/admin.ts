import { createHash, timingSafeEqual } from "node:crypto";
import {
  type Account,
  AccountNotFoundError,
  AccountStore,
  AccountTokens,
  AuthRequestError,
} from "@via/codex-auth";
import { CodexUpstream } from "@via/codex-upstream";
import { DuplicateKeyNameError, KeyNotFoundError, KeyStore } from "@via/keys";
import { Providers } from "@via/providers";
import { LoginNotFoundError, Logins } from "./logins.ts";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiScalar,
  HttpApiSecurity,
  OpenApi,
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

/** A started device-code login: the code to enter, and where to enter it. */
const StartedLogin = Schema.Struct({
  id: Schema.String,
  userCode: Schema.String,
  verificationUrl: Schema.String,
});

/** Where a device-code login stands. */
const LoginStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("added"), account: AdminAccount }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }),
]);

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
  .add(
    HttpApiEndpoint.post("login", "/accounts/logins", {
      success: StartedLogin.pipe(HttpApiSchema.status(201)),
      error: AuthRequestError.pipe(HttpApiSchema.status(502)),
    }),
  )
  .add(
    HttpApiEndpoint.get("loginStatus", "/accounts/logins/:id", {
      params: { id: Schema.String },
      success: LoginStatus,
      error: LoginNotFoundError.pipe(HttpApiSchema.status(404)),
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/accounts/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        label: Schema.optional(Schema.String),
        enabled: Schema.optional(Schema.Boolean),
      }),
      success: AdminAccount,
      error: AccountNotFoundError.pipe(HttpApiSchema.status(404)),
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/accounts/:id", {
      params: { id: Schema.String },
      error: AccountNotFoundError.pipe(HttpApiSchema.status(404)),
    }),
  )
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
  .add(UsageGroup)
  .annotate(OpenApi.Title, "via admin API")
  .annotate(
    OpenApi.Description,
    "Manages the ChatGPT accounts and client API keys of a via server, and reports their usage.",
  ) {}

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
      .handle("login", () =>
        Effect.gen(function* () {
          return yield* logins.start();
        }),
      )
      .handle("loginStatus", ({ params }) =>
        Effect.gen(function* () {
          const login = yield* logins.status(params.id);

          return login.status === "added"
            ? { status: login.status, account: withoutTokens(login.account) }
            : login;
        }),
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
