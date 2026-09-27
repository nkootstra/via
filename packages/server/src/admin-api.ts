// The admin API's contract: its endpoints, what they take and answer, and how they are
// secured. `admin.ts` implements it. It imports only `effect` and the import-light
// subpaths of via's other packages, so a browser can bundle it, as `@via/server/admin-api`,
// for an API client.
import { AccountNotFoundError, AuthRequestError } from "@via/codex-auth/errors";
import { DuplicateKeyNameError, KeyNotFoundError } from "@via/keys/errors";
import { ProviderUsage } from "@via/providers/schemas";
import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
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
        windowMinutes: Schema.Finite,
        usedPercent: Schema.Finite,
        resetsAt: Schema.String,
      }),
    ),
  }),
  Schema.Struct({ id: Schema.String, label: Schema.String, error: Schema.String }),
]);

const Usage = Schema.Struct({
  accounts: Schema.Array(AccountUsage),
  providers: Schema.Array(ProviderUsage),
});

/** No login with this id was started since the server did; the admin API answers it as a 404. */
export class LoginNotFoundError extends Schema.TaggedError<LoginNotFoundError>()(
  "LoginNotFoundError",
  { id: Schema.String },
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

/**
 * Bearer auth, spelled `bearer` in the spec: `HttpApiSecurity.bearer` says `Bearer`,
 * which Scalar's API client mistakes for Basic auth. Headers match either way.
 */
const bearer = HttpApiSecurity.http({ scheme: "bearer" });

/** Lets a request through only with `Authorization: Bearer <VIA_ADMIN_KEY>`. */
export class AdminAuthorization extends HttpApiMiddleware.Service<AdminAuthorization>()(
  "via/AdminAuthorization",
  { security: { bearer }, error: Unauthorized },
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

export class AdminApi extends HttpApi.make("via-admin")
  .add(AccountsGroup)
  .add(KeysGroup)
  .add(UsageGroup)
  .annotate(OpenApi.Title, "via admin API")
  .annotate(
    OpenApi.Description,
    "Manages the ChatGPT accounts and client API keys of a via server, and reports their usage.",
  ) {}
