// The admin API's contract: its endpoints, what they take and answer, and how they are
// secured. `admin.ts` implements it. It imports only `effect` and the import-light
// subpaths of via's other packages, so a browser can bundle it, as `@via/server/admin-api`,
// for an API client.
import { AccountNotFoundError, AuthRequestError } from "@via/codex-auth/errors";
import { FallbackRuleInvalidError, FallbackRuleNotFoundError } from "@via/fallbacks/rule";
import { DuplicateKeyNameError, KeyNotFoundError } from "@via/keys/errors";
import {
  DuplicateOpencodeGoKeyError,
  OllamaAddressInvalidError,
  OllamaNotEditableError,
  OllamaUnreachableError,
  OpencodeGoAccountNotFoundError,
  OpencodeGoKeyRejectedError,
  OpencodeGoUnavailableError,
  OpenrouterKeyRejectedError,
  OpenrouterNotEditableError,
  OpenrouterNotSetUpError,
  OpenrouterUnavailableError,
} from "@via/providers/errors";
import { OpenrouterBudget, ProviderState } from "@via/providers/schemas";
import { UsageEntry } from "@via/usage/entry";
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

/**
 * A name or label a request carries: longer than any real one, short enough that
 * a request can't make via store or show a huge string. (An id in a path is kept
 * to 100 characters by the router, which answers a longer one 404.)
 */
const Name = Schema.String.check(Schema.isMaxLength(200));

/** A key a request carries, the admin key or an API key: longer than any real one. */
const Key = Schema.Redacted(Schema.String.check(Schema.isMaxLength(1024)));

/** An account as the admin API shows it: everything but its tokens. */
const AdminAccount = Schema.Struct({
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
/** OpenRouter's key budget as OpenRouter last told it, null for a key without a limit, or why not. */
const OpenrouterUsage = Schema.Union([
  Schema.Struct({ ...fetched, budget: Schema.NullOr(OpenrouterBudget) }),
  Schema.Struct({ ...fetched, error: Schema.String }),
]);

const Usage = Schema.Struct({
  accounts: Schema.Array(AccountUsage),
  opencodeGo: Schema.Array(OpencodeGoUsage),
  /** None while via has no OpenRouter key. */
  openrouter: Schema.NullOr(OpenrouterUsage),
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
const Pool = Schema.Struct({
  accounts: Schema.Array(PoolAccount),
  opencodeGo: Schema.Array(PoolAccount),
  providers: Schema.Array(PoolProvider),
});

/**
 * Where Ollama is: the address the web UI saved, or the one config.yaml sets up,
 * which only config.yaml can change.
 */
const AdminOllama = Schema.Struct({ address: Schema.String, fromConfig: Schema.Boolean });

/**
 * OpenRouter: its key by its last four characters, and the models via offers
 * of it. One config.yaml sets up offers every model, and only config.yaml changes.
 */
const AdminOpenrouter = Schema.Struct({
  key: Schema.String,
  models: Schema.Array(Schema.String),
  fromConfig: Schema.Boolean,
});

/** A model OpenRouter lists, to enable or not: its prices are per million tokens. */
const OpenrouterCatalogModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  inputPerMillion: Schema.NullOr(Schema.Finite),
  outputPerMillion: Schema.NullOr(Schema.Finite),
  contextLength: Schema.NullOr(Schema.Finite),
});

/** A model as `/v1/models` lists it: an id, plus whatever else via or its provider tells. */
const Model = Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [Schema.JsonObject]);

/**
 * Whether a model could serve a request now: `cooling` until the first of its
 * accounts' cooldowns ends, with why, and `unavailable` when it has no
 * account that could (`no_accounts`), is an OpenRouter model that isn't
 * enabled (`not_enabled`), or is a model via doesn't know (`not_listed`).
 * Outages aren't known until a request meets them.
 */
const FallbackAvailability = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available") }),
  Schema.Struct({ status: Schema.Literal("cooling"), until: Schema.String, reason: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals(["no_accounts", "not_enabled", "not_listed"]),
  }),
]);

/**
 * A model's fallbacks, and how they stand: whether the model and each fallback
 * could serve now, and `serving`, the one that would answer a request for the
 * model now, the model itself first; null when none could.
 */
const AdminFallback = Schema.Struct({
  model: Schema.String,
  fallbacks: Schema.Array(Schema.String),
  status: Schema.Struct({
    source: FallbackAvailability,
    fallbacks: Schema.Array(FallbackAvailability),
    serving: Schema.NullOr(Schema.String),
  }),
});

/**
 * Everything the admin UI's pages show that via knows without asking anyone: the
 * pool, the latest usage, the ChatGPT and OpenCode Go accounts (keys masked), the
 * API keys and the models. A signed-in page gets it in its shell, and `GET /admin/events`
 * sends it again whenever it changes. `session` says the page is signed in, which
 * it always is when it gets this.
 */
export const AdminState = Schema.Struct({
  session: Schema.Literal(true),
  /** The version of the via that sent it: a page built for another was updated under it. */
  version: Schema.String,
  pool: Pool,
  usage: Usage,
  accounts: Schema.Array(AdminAccount),
  opencodeGo: Schema.Array(AdminOpencodeGoAccount),
  keys: Schema.Array(AdminKey),
  models: Schema.Array(Model),
  /** Where Ollama is, if via knows one. */
  ollama: Schema.NullOr(AdminOllama),
  /** OpenRouter's key and the models it enables, if via has one. */
  openrouter: Schema.NullOr(AdminOpenrouter),
  /** The fallback rules, and how each stands now. */
  fallbacks: Schema.Array(AdminFallback),
  /** Why the fallback rules can't be read, when they can't; requests don't fall back until then. */
  fallbacksError: Schema.NullOr(Schema.String),
});

/** The one event `GET /admin/events` sends: the whole admin state, as JSON. */
export const StateEvent = Schema.Struct({
  event: Schema.Literal("state"),
  data: Schema.fromJsonString(AdminState),
});

/**
 * Sent when the usage history changed, as when via kept a request, so a page
 * showing it fetches it again. It carries nothing more: the history is far too
 * big to send whole, and a page asks only for what it shows.
 */
const HistoryEvent = Schema.Struct({
  event: Schema.Literal("history"),
  data: Schema.String,
});

/** Every event `GET /admin/events` sends. */
export const AdminEvent = Schema.Union([StateEvent, HistoryEvent]);

/** No login with this id was started since the server did; the admin API answers it as a 404. */
export class LoginNotFoundError extends Schema.TaggedError<LoginNotFoundError>()(
  "LoginNotFoundError",
  { id: Schema.String },
) {
  override get message() {
    return "This sign-in expired or via restarted. Start it again.";
  }
}

/** Too many logins are waiting for approval; the admin API refuses another until one ends. */
export class TooManyLoginsError extends Schema.TaggedError<TooManyLoginsError>()(
  "TooManyLoginsError",
  { message: Schema.String },
  { httpApiStatus: 429 },
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

/** The fallback rules file can't be read or written; `message` says which file and why. */
export class FallbackRulesFileError extends Schema.TaggedError<FallbackRulesFileError>()(
  "FallbackRulesFileError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

/**
 * Bearer auth, spelled `bearer` in the spec: `HttpApiSecurity.bearer` says `Bearer`,
 * which Scalar's API client mistakes for Basic auth. Headers match either way.
 */
export const bearer = HttpApiSecurity.http({ scheme: "bearer" });

/** The session cookie `POST /admin/session` sets. */
export const session = HttpApiSecurity.apiKey({ key: "via_session", in: "cookie" });

/**
 * Lets a request through with `Authorization: Bearer <VIA_ADMIN_KEY>`, or with a
 * session cookie. A request that changes something with only the cookie must also
 * come from via's own origin and carry `x-via-csrf: 1`, which a cross-site form can't.
 * A wrong bearer key counts as a failed sign-in, so an address refused sign-ins is
 * refused the bearer key too, with 429. Reading the cookie takes the request, as any HTTP middleware does.
 *
 * @effect-expect-leaking HttpServerRequest | ParsedSearchParams | RouteContext
 */
export class AdminAuthorization extends HttpApiMiddleware.Service<AdminAuthorization>()(
  "via/AdminAuthorization",
  { security: { bearer, session }, error: [Unauthorized, Forbidden, TooManySignInsError] },
) {}

/** An integer, as a query parameter carries it, such as a time in epoch milliseconds. */
const IntParam = Schema.FiniteFromString.check(Schema.isInt());

/** What the usage history totals by. */
const GroupBy = Schema.Literals(["model", "account", "key", "provider"]);

/** The span of time a history query covers: from `from` up to, not including, `to`. */
const HistoryRange = { from: IntParam, to: IntParam };

/**
 * What narrows a history query: a model, an account (or `provider:<name>`, a
 * provider's requests no account served), a key, failed requests only, and
 * requests another model answered for the one asked for, or none of those.
 */
const HistoryFilters = {
  model: Schema.optionalKey(Name),
  accountId: Schema.optionalKey(Name),
  keyId: Schema.optionalKey(Name),
  outcome: Schema.optionalKey(Schema.Literals(["ok", "error"])),
  fellBack: Schema.optionalKey(Schema.Literals(["true", "false"])),
};

/** Request and token counts; a sum is 0 where no request reported its usage. */
const Totals = {
  requests: Schema.Finite,
  /** How many of `requests` reported their usage: the token sums leave the rest out. */
  measured: Schema.Finite,
  inputTokens: Schema.Finite,
  cachedTokens: Schema.Finite,
  outputTokens: Schema.Finite,
  reasoningTokens: Schema.Finite,
};

/** The median and 95th percentile of a timing, in milliseconds; null without any. */
const Percentiles = Schema.Struct({
  p50: Schema.OptionFromNullOr(Schema.Finite),
  p95: Schema.OptionFromNullOr(Schema.Finite),
});

/**
 * What usage cost, in USD: what upstreams billed, and what the rest would have
 * cost at API prices. `unpriced` names the models via knows no price for, whose
 * tokens that leaves out.
 */
const Cost = Schema.Struct({
  apiEquivalentUsd: Schema.Finite,
  billedUsd: Schema.Finite,
  unpriced: Schema.Array(Schema.String),
});

/** One group's usage in one hour or day. */
const HistoryPoint = Schema.Struct({
  /** When the hour or day starts, in epoch milliseconds. */
  bucket: Schema.Finite,
  group: Schema.String,
  ...Totals,
});

/** The usage of the requests in a range, as a whole: `errors` counts the failed ones. */
const HistoryTotals = Schema.Struct({
  ...Totals,
  /** Answered requests that reported no usage, which the token sums leave out. */
  unmeasured: Schema.Finite,
  errors: Schema.Finite,
  /** Requests another model answered because the one asked for couldn't serve. */
  fellBack: Schema.Finite,
  firstChunkMs: Percentiles,
  cost: Cost,
});

/** One group's usage over a range, and its name: the key's or account's as it is now. */
const HistoryGroup = Schema.Struct({
  group: Schema.String,
  label: Schema.String,
  ...HistoryTotals.fields,
});

const HistoryBreakdown = Schema.Struct({
  /** The most requested first. */
  groups: Schema.Array(HistoryGroup),
  totals: HistoryTotals,
});

/** Where the next page of requests starts, when there is one. */
const RequestCursor = Schema.Struct({ at: Schema.Finite, requestId: Schema.String });

const RequestPage = Schema.Struct({
  requests: Schema.Array(UsageEntry),
  next: Schema.OptionFromNullOr(RequestCursor),
});

/** Signing in to the admin API with the admin key, for a browser. */
class SessionGroup extends HttpApiGroup.make("session")
  .add(
    HttpApiEndpoint.post("signIn", "/session", {
      payload: Schema.Struct({ key: Key }),
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
      error: [AuthRequestError.pipe(HttpApiSchema.status(502)), TooManyLoginsError],
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
        label: Schema.optional(Name),
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
        apiKey: Key,
        label: Schema.optional(Name),
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
        label: Schema.optional(Name),
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

/** What Ollama is given as: an address, as its app shows it or with `/v1`. */
const OllamaAddressPayload = Schema.Struct({ address: Schema.String });

class OllamaGroup extends HttpApiGroup.make("ollama")
  .add(HttpApiEndpoint.get("get", "/ollama", { success: Schema.NullOr(AdminOllama) }))
  .add(
    HttpApiEndpoint.put("set", "/ollama", {
      payload: OllamaAddressPayload,
      success: AdminOllama,
      error: [
        OllamaAddressInvalidError.pipe(HttpApiSchema.status(400)),
        OllamaNotEditableError.pipe(HttpApiSchema.status(409)),
      ],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/ollama", {
      error: OllamaNotEditableError.pipe(HttpApiSchema.status(409)),
    }),
  )
  .add(
    HttpApiEndpoint.post("check", "/ollama/check", {
      payload: OllamaAddressPayload,
      success: Schema.Struct({
        address: Schema.String,
        version: Schema.String,
        models: Schema.Array(Schema.String),
      }),
      error: [
        OllamaAddressInvalidError.pipe(HttpApiSchema.status(400)),
        OllamaUnreachableError.pipe(HttpApiSchema.status(422)),
      ],
    }),
  )
  .middleware(AdminAuthorization)
  .prefix("/admin") {}

class OpenrouterGroup extends HttpApiGroup.make("openrouter")
  .add(HttpApiEndpoint.get("get", "/openrouter", { success: Schema.NullOr(AdminOpenrouter) }))
  .add(
    HttpApiEndpoint.put("setKey", "/openrouter/key", {
      payload: Schema.Struct({ apiKey: Key }),
      success: AdminOpenrouter,
      error: [
        OpenrouterNotEditableError.pipe(HttpApiSchema.status(409)),
        OpenrouterKeyRejectedError.pipe(HttpApiSchema.status(422)),
        OpenrouterUnavailableError.pipe(HttpApiSchema.status(502)),
      ],
    }),
  )
  .add(
    HttpApiEndpoint.put("setModels", "/openrouter/models", {
      payload: Schema.Struct({ models: Schema.Array(Schema.String) }),
      success: AdminOpenrouter,
      error: [
        OpenrouterNotEditableError.pipe(HttpApiSchema.status(409)),
        OpenrouterNotSetUpError.pipe(HttpApiSchema.status(409)),
      ],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/openrouter", {
      error: OpenrouterNotEditableError.pipe(HttpApiSchema.status(409)),
    }),
  )
  .add(
    HttpApiEndpoint.get("catalog", "/openrouter/catalog", {
      success: Schema.Array(OpenrouterCatalogModel),
      error: [
        OpenrouterNotSetUpError.pipe(HttpApiSchema.status(409)),
        OpenrouterUnavailableError.pipe(HttpApiSchema.status(502)),
      ],
    }),
  )
  .middleware(AdminAuthorization)
  .prefix("/admin") {}

class KeysGroup extends HttpApiGroup.make("keys")
  .add(HttpApiEndpoint.get("list", "/keys", { success: Schema.Array(AdminKey) }))
  .add(
    HttpApiEndpoint.post("create", "/keys", {
      // A plain fields object would make this a form body; a Struct makes it JSON.
      payload: Schema.Struct({ name: Name }),
      success: CreatedKey.pipe(HttpApiSchema.status(201)),
      error: DuplicateKeyNameError.pipe(HttpApiSchema.status(409)),
    }),
  )
  .add(
    HttpApiEndpoint.patch("rename", "/keys/:idOrName", {
      params: { idOrName: Schema.String },
      payload: Schema.Struct({ name: Name }),
      success: AdminKey,
      error: [
        KeyNotFoundError.pipe(HttpApiSchema.status(404)),
        DuplicateKeyNameError.pipe(HttpApiSchema.status(409)),
      ],
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

/**
 * The models a model falls back to when it can't serve. A model is named in the
 * body or the query, not the path: a provider's id holds slashes.
 */
class FallbacksGroup extends HttpApiGroup.make("fallbacks")
  .add(
    HttpApiEndpoint.get("list", "/fallbacks", {
      success: Schema.Array(AdminFallback),
      error: FallbackRulesFileError,
    }),
  )
  .add(
    HttpApiEndpoint.put("set", "/fallbacks", {
      // Checked by the handler, so a rule it refuses says why.
      payload: Schema.Struct({ model: Schema.String, fallbacks: Schema.Array(Schema.String) }),
      success: AdminFallback,
      error: [FallbackRuleInvalidError.pipe(HttpApiSchema.status(400)), FallbackRulesFileError],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/fallbacks", {
      query: { model: Name },
      error: [FallbackRuleNotFoundError.pipe(HttpApiSchema.status(404)), FallbackRulesFileError],
    }),
  )
  .middleware(AdminAuthorization)
  .prefix("/admin") {}

class UsageGroup extends HttpApiGroup.make("usage")
  .add(HttpApiEndpoint.get("get", "/usage", { success: Usage }))
  .middleware(AdminAuthorization)
  .prefix("/admin") {}

/** Every request via kept in the last 90 days, totalled or one by one. */
class UsageHistoryGroup extends HttpApiGroup.make("history")
  .add(
    HttpApiEndpoint.get("series", "/history/series", {
      query: {
        ...HistoryRange,
        bucket: Schema.Literals(["hour", "day"]),
        /** Minutes the viewer's clock is ahead of UTC, so their days start at midnight. */
        tzOffsetMinutes: IntParam.check(Schema.isBetween({ minimum: -840, maximum: 840 })),
        groupBy: GroupBy,
        ...HistoryFilters,
      },
      success: Schema.Struct({ points: Schema.Array(HistoryPoint) }),
    }),
  )
  .add(
    HttpApiEndpoint.get("breakdown", "/history/breakdown", {
      query: { ...HistoryRange, groupBy: GroupBy, ...HistoryFilters },
      success: HistoryBreakdown,
    }),
  )
  .add(
    HttpApiEndpoint.get("requests", "/history/requests", {
      query: {
        ...HistoryRange,
        limit: Schema.optionalKey(IntParam.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
        /** The `next` of the page before: the list goes on after that request. */
        afterAt: Schema.optionalKey(IntParam),
        afterId: Schema.optionalKey(Name),
        ...HistoryFilters,
      },
      success: RequestPage,
    }),
  )
  .add(
    HttpApiEndpoint.delete("clear", "/history", {
      success: Schema.Struct({ deleted: Schema.Finite }),
    }),
  )
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
      success: HttpApiSchema.StreamSse({ events: AdminEvent }),
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
  .add(OllamaGroup)
  .add(OpenrouterGroup)
  .add(KeysGroup)
  .add(UsageGroup)
  .add(UsageHistoryGroup)
  .add(FallbacksGroup)
  .add(PoolGroup)
  .add(ModelsGroup)
  .add(EventsGroup)
  .annotate(OpenApi.Title, "via admin API")
  .annotate(
    OpenApi.Description,
    "Manages the ChatGPT accounts, OpenCode Go keys and client API keys of a via server, and reports their usage, their state in the pool and the models it serves.",
  ) {}
