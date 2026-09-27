// The admin API's contract: its endpoints, what they take and answer, and how they are
// secured. `admin.ts` implements it. It imports only `effect` and the import-light
// subpaths of via's other packages, so a browser can bundle it, as `@via/server/admin-api`,
// for an API client.
import { AccountNotFoundError, AuthRequestError } from "@via/codex-auth/errors";
import { DuplicateKeyNameError, KeyNotFoundError } from "@via/keys/errors";
import {
  DuplicateOpencodeGoKeyError,
  OpencodeGoAccountNotFoundError,
  OpencodeGoKeyRejectedError,
  OpencodeGoUnavailableError,
} from "@via/providers/errors";
import { ProviderState } from "@via/providers/schemas";
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
export const AdminAccount = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  email: Schema.String,
  plan: Schema.String,
  enabled: Schema.Boolean,
  createdAt: Schema.String,
});

/** An OpenCode Go account as the admin API shows it: its key only by its last four characters. */
const AdminOpencodeGoAccount = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** The key's last four characters, as `…abcd`. */
  key: Schema.String,
  enabled: Schema.Boolean,
  createdAt: Schema.String,
  /**
   * The deprecated environment variable its key was imported from, while that
   * variable is still set.
   */
  environmentVariable: Schema.optionalKey(Schema.String),
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
  Schema.Struct({ status: Schema.Literal("updated"), account: AdminAccount }).annotate({
    description:
      "The account was already in the pool: it was signed in again with fresh tokens, and taken out of any lockout.",
  }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }),
]);

/** A client API key as the admin API lists it: never the key itself. */
const AdminKey = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String).annotate({
    description:
      "When a client last used the key; null if never. It survives a restart to within a minute.",
  }),
});

/** A newly created client API key; the only time the key is shown. */
const CreatedKey = Schema.Struct({ id: Schema.String, name: Schema.String, key: Schema.String });

/** When via last asked for a usage report (ISO 8601). */
const fetched = { fetchedAt: Schema.String };

/** An account's rate limit windows, or why ChatGPT did not report them, and when via asked. */
const AccountUsage = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    ...fetched,
    windows: Schema.Array(
      Schema.Struct({
        windowMinutes: Schema.Finite,
        usedPercent: Schema.Finite,
        resetsAt: Schema.String,
      }),
    ),
  }),
  Schema.Struct({ id: Schema.String, label: Schema.String, ...fetched, error: Schema.String }),
]);

/**
 * An OpenCode Go account's usage windows, each by name (such as `rolling`, `weekly`
 * and `monthly`), or why OpenCode Go did not report them, and when via asked.
 */
const OpencodeGoUsage = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    ...fetched,
    windows: Schema.Array(
      Schema.Struct({
        window: Schema.String,
        status: Schema.String,
        usedPercent: Schema.Finite,
        resetsAt: Schema.String,
      }),
    ),
  }),
  Schema.Struct({ id: Schema.String, label: Schema.String, ...fetched, error: Schema.String }),
]);

/**
 * The latest usage via has, without waiting for any: an account it has none for
 * yet is left out. `refreshing` says it is asking for newer usage now.
 */
export const Usage = Schema.Struct({
  accounts: Schema.Array(AccountUsage),
  opencodeGo: Schema.Array(OpencodeGoUsage),
  refreshing: Schema.Boolean,
});

/** Whether the pool hands an account out: available, cooling down until when and why, or locked out. */
const PoolAccountState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available") }),
  Schema.Struct({
    status: Schema.Literal("cooling"),
    until: Schema.String,
    reason: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("auth_error"), reason: Schema.String }),
]);

/** An account as the pool sees it. */
const PoolAccount = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  enabled: Schema.Boolean,
  state: PoolAccountState,
});

/**
 * A configured provider with its own API key, next to the accounts. Requests for
 * its models go straight to it.
 */
const PoolProvider = Schema.Struct({ name: Schema.String, state: ProviderState });

/**
 * Everything that serves requests: the ChatGPT accounts, the OpenCode Go
 * accounts, and the configured providers.
 */
export const Pool = Schema.Struct({
  accounts: Schema.Array(PoolAccount),
  opencodeGo: Schema.Array(PoolAccount),
  providers: Schema.Array(PoolProvider),
});

/**
 * Everything the admin UI's pages show that via knows without asking anyone: the
 * pool, the latest usage, the ChatGPT and OpenCode Go accounts (keys masked), and
 * the API keys. A signed-in page gets it in its shell, and `GET /admin/events`
 * sends it again whenever it changes. `session` says the page is signed in, which
 * it always is when it gets this.
 */
export const AdminState = Schema.Struct({
  session: Schema.Literal(true),
  pool: Pool,
  usage: Usage,
  accounts: Schema.Array(AdminAccount),
  opencodeGo: Schema.Array(AdminOpencodeGoAccount),
  keys: Schema.Array(AdminKey),
});

/** The one event `GET /admin/events` sends: the whole admin state, as JSON. */
export const StateEvent = Schema.Struct({
  event: Schema.Literal("state"),
  data: Schema.fromJsonString(AdminState),
});

/** A model as `/v1/models` lists it: an id, plus whatever else via or its provider tells. */
const Model = Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [Schema.JsonObject]);

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

/** Too many failed sign-ins in the last minute; the admin API refuses every sign-in for now. */
export class TooManySignInsError extends Schema.TaggedError<TooManySignInsError>()(
  "TooManySignInsError",
  { message: Schema.String },
  { httpApiStatus: 429 },
) {}

/**
 * A request signed in with a session cookie that changes something, but without the
 * `x-via-csrf` header or from another origin: what a cross-site request forgery looks like.
 */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/**
 * Bearer auth, spelled `bearer` in the spec: `HttpApiSecurity.bearer` says `Bearer`,
 * which Scalar's API client mistakes for Basic auth. Headers match either way.
 */
const bearer = HttpApiSecurity.http({ scheme: "bearer" });

/** The session cookie `POST /admin/session` sets. */
export const session = HttpApiSecurity.apiKey({ key: "via_session", in: "cookie" });

/**
 * Lets a request through with `Authorization: Bearer <VIA_ADMIN_KEY>`, or with a
 * session cookie. A request that changes something with only the cookie must also
 * come from via's own origin and carry `x-via-csrf: 1`, which a cross-site form can't.
 * Reading the cookie takes the request, as any HTTP middleware does.
 *
 * @effect-expect-leaking HttpServerRequest | ParsedSearchParams | RouteContext
 */
export class AdminAuthorization extends HttpApiMiddleware.Service<AdminAuthorization>()(
  "via/AdminAuthorization",
  { security: { bearer, session }, error: [Unauthorized, Forbidden] },
) {}

/** Signing in to the admin API with the admin key, for a browser. */
class SessionGroup extends HttpApiGroup.make("session")
  .add(
    HttpApiEndpoint.post("signIn", "/session", {
      payload: Schema.Struct({ key: Schema.Redacted(Schema.String) }),
      error: [Unauthorized, TooManySignInsError],
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/session", { success: HttpApiSchema.Empty(200) }).middleware(
      AdminAuthorization,
    ),
  )
  .add(HttpApiEndpoint.delete("signOut", "/session").middleware(AdminAuthorization))
  .prefix("/admin") {}

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

/**
 * OpenCode Go's API keys, as accounts. They are named by id only: a label would
 * end up in URLs, and from there in proxy and access logs.
 */
class OpencodeGoGroup extends HttpApiGroup.make("opencodeGo")
  .add(
    HttpApiEndpoint.get("list", "/opencode-go/accounts", {
      success: Schema.Array(AdminOpencodeGoAccount),
    }),
  )
  .add(
    HttpApiEndpoint.post("add", "/opencode-go/accounts", {
      // A plain fields object would make this a form body; a Struct makes it JSON.
      payload: Schema.Struct({
        apiKey: Schema.Redacted(Schema.String),
        label: Schema.optional(Schema.String),
      }),
      success: AdminOpencodeGoAccount.pipe(HttpApiSchema.status(201)),
      error: [
        DuplicateOpencodeGoKeyError.pipe(HttpApiSchema.status(409)),
        OpencodeGoKeyRejectedError.pipe(HttpApiSchema.status(422)),
        OpencodeGoUnavailableError.pipe(HttpApiSchema.status(502)),
      ],
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/opencode-go/accounts/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        label: Schema.optional(Schema.String),
        enabled: Schema.optional(Schema.Boolean),
      }),
      success: AdminOpencodeGoAccount,
      error: OpencodeGoAccountNotFoundError.pipe(HttpApiSchema.status(404)),
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/opencode-go/accounts/:id", {
      params: { id: Schema.String },
      error: OpencodeGoAccountNotFoundError.pipe(HttpApiSchema.status(404)),
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

class PoolGroup extends HttpApiGroup.make("pool")
  .add(HttpApiEndpoint.get("get", "/pool", { success: Pool }))
  .middleware(AdminAuthorization)
  .prefix("/admin") {}

/** The admin state, pushed to a page as it changes, so the page needn't poll. */
class EventsGroup extends HttpApiGroup.make("events")
  .add(
    HttpApiEndpoint.get("stream", "/events", {
      success: HttpApiSchema.StreamSse({ events: StateEvent }),
    }),
  )
  .middleware(AdminAuthorization)
  .prefix("/admin") {}

class ModelsGroup extends HttpApiGroup.make("models")
  .add(HttpApiEndpoint.get("list", "/models", { success: Schema.Array(Model) }))
  .middleware(AdminAuthorization)
  .prefix("/admin") {}

export class AdminApi extends HttpApi.make("via-admin")
  .add(SessionGroup)
  .add(AccountsGroup)
  .add(OpencodeGoGroup)
  .add(KeysGroup)
  .add(UsageGroup)
  .add(PoolGroup)
  .add(ModelsGroup)
  .add(EventsGroup)
  .annotate(OpenApi.Title, "via admin API")
  .annotate(
    OpenApi.Description,
    "Manages the ChatGPT accounts, OpenCode Go keys and client API keys of a via server, and reports their usage, their state in the pool and the models it serves.",
  ) {}
