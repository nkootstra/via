/**
 * A stand-in for via's admin API, for MSW: one handler per route, answering
 * from an in-memory state that tests seed and inspect. Every body is encoded
 * with the contract's own schemas, so the fixtures are typed by it and can't
 * drift from what via sends. Tests script errors by overriding a handler with
 * `server.use(...)` and `failure(...)`.
 */
import { AdminApi, LoginNotFoundError, Unauthorized } from "@via/server/admin-api";
import { AccountNotFoundError } from "@via/codex-auth/errors";
import { DuplicateKeyNameError, KeyNotFoundError } from "@via/keys/errors";
import {
  DuplicateOpencodeGoKeyError,
  OllamaAddressInvalidError,
  OllamaNotEditableError,
  OllamaUnreachableError,
  OpencodeGoAccountNotFoundError,
  OpencodeGoKeyRejectedError,
} from "@via/providers/errors";
import { Option, Schema } from "effect";
import type {
  Account,
  Key,
  LoginStatus,
  HistoryBreakdown,
  HistorySeries,
  Model,
  Ollama,
  OllamaCheck,
  OpencodeGoAccount,
  Pool,
  Usage,
  UsageRequest,
} from "../api/types.ts";
import { http, HttpResponse, type JsonBodyType, type PathParams } from "msw";

const { accounts, opencodeGo, ollama, keys, usage, pool, models, history } = AdminApi.groups;

type Encodable = Schema.Top & { readonly EncodingServices: never };

/**
 * A JSON response of `value`, encoded by `schema` as via would. Tests script
 * errors with it: `failure(Unauthorized, new Unauthorized({...}), 401)`.
 */
export function failure<S extends Encodable>(schema: S, value: S["Type"], status = 200) {
  const body: JsonBodyType = Schema.decodeSync(Schema.fromJsonString(Schema.Json))(
    Schema.encodeUnknownSync(Schema.fromJsonString(schema))(value),
  );

  return HttpResponse.json(body, { status });
}

/** An endpoint's success body, encoded as via would. */
function ok<S extends Encodable>(
  endpoint: { readonly success: ReadonlySet<Schema.Top>; readonly "~Success": S },
  value: S["Type"],
  status = 200,
) {
  // SAFETY: `success` holds the endpoint's success schemas, and every admin
  // endpoint with a body has exactly one: the one `~Success` types.
  const schema = [...endpoint.success][0] as S;

  return failure(schema, value, status);
}

const noContent = () => new HttpResponse(null, { status: 204 });

const unauthorized = () =>
  failure(Unauthorized, new Unauthorized({ message: "Sign in first" }), 401);

/** What the fake via holds. Tests seed it, act, then look at it. */
export interface AdminState {
  signedIn: boolean;
  /** The admin key that signs in. */
  readonly adminKey: string;
  accounts: Array<Account>;
  opencodeGo: Array<OpencodeGoAccount>;
  /** The OpenCode Go keys OpenCode Go refuses when via checks them. */
  refusedKeys: Array<string>;
  keys: Array<Key>;
  /** Each started login answers its statuses in turn, then keeps the last. */
  readonly logins: Map<string, Array<LoginStatus>>;
  /** The statuses the next started login will go through. */
  nextLogin: Array<LoginStatus>;
  pool: Pool;
  usage: Usage;
  models: Array<Model>;
  /** Every request the fake received, as "METHOD /path". */
  readonly requests: Array<string>;
  /** What `/admin/history/series` answers, whatever it is asked. */
  historySeries: HistorySeries;
  /** What `/admin/history/breakdown` answers, by what it groups by. */
  historyBreakdown: ReadonlyMap<string, HistoryBreakdown>;
  /** The requests `/admin/history/requests` pages through, newest first, filtered by model. */
  historyRequests: Array<UsageRequest>;
  /** The query of every history request the fake received, in order. */
  readonly historyQueries: Array<URLSearchParams>;
  /** Where Ollama is, if via knows one. */
  ollama: Ollama | null;
  /** What checking each address finds: Ollama's version and models, or why it can't be used. */
  ollamaAt: ReadonlyMap<string, Omit<OllamaCheck, "address"> | { readonly reason: string }>;
}

export const account = (fields: Partial<Account> & Pick<Account, "id" | "label">): Account => ({
  email: `${fields.label}@example.com`,
  plan: "plus",
  enabled: true,
  createdAt: "2026-09-01T10:00:00.000Z",
  ...fields,
});

export const opencodeGoAccount = (
  fields: Partial<OpencodeGoAccount> & Pick<OpencodeGoAccount, "id" | "label">,
): OpencodeGoAccount => ({
  key: "…abcd",
  enabled: true,
  createdAt: "2026-09-02T10:00:00.000Z",
  ...fields,
});

export function createAdminState(seed: Partial<AdminState> = {}): AdminState {
  return {
    signedIn: true,
    adminKey: "the-admin-key",
    accounts: [],
    opencodeGo: [],
    refusedKeys: [],
    keys: [],
    logins: new Map(),
    nextLogin: [{ status: "pending" }],
    pool: { accounts: [], opencodeGo: [], providers: [] },
    usage: { accounts: [], opencodeGo: [], refreshing: false },
    models: [],
    requests: [],
    historySeries: { points: [] },
    historyBreakdown: new Map(),
    historyRequests: [],
    historyQueries: [],
    ollama: null,
    ollamaAt: new Map(),
    ...seed,
  };
}

const at = (path: string) => `*/admin${path}`;

const OllamaAddressBody = Schema.Struct({ address: Schema.String });

export function adminHandlers(state: AdminState) {
  // Every route but signing in needs the session.
  const guarded =
    <P extends PathParams>(
      handle: (info: {
        readonly params: P;
        readonly request: Request;
      }) => Response | Promise<Response>,
    ) =>
    (info: { readonly params: P; readonly request: Request }) => {
      state.requests.push(`${info.request.method} ${new URL(info.request.url).pathname}`);

      return state.signedIn ? handle(info) : unauthorized();
    };

  return [
    http.post(at("/session"), async ({ request }) => {
      state.requests.push("POST /admin/session");

      const { key } = Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String }))(
        await request.json(),
      );

      if (key !== state.adminKey) {
        return failure(Unauthorized, new Unauthorized({ message: "Wrong admin key" }), 401);
      }

      state.signedIn = true;

      return noContent();
    }),
    http.get(
      at("/session"),
      guarded(() => new HttpResponse(null, { status: 200 })),
    ),
    http.delete(
      at("/session"),
      guarded(() => {
        state.signedIn = false;

        return noContent();
      }),
    ),

    http.get(
      at("/accounts"),
      guarded(() => ok(accounts.endpoints.list, state.accounts)),
    ),
    http.post(
      at("/accounts/logins"),
      guarded(() => {
        const id = `login-${state.logins.size + 1}`;
        state.logins.set(id, [...state.nextLogin]);

        return ok(
          accounts.endpoints.login,
          { id, userCode: "WXYZ-2345", verificationUrl: "https://auth.openai.com/codex/device" },
          201,
        );
      }),
    ),
    http.get<{ id: string }>(
      at("/accounts/logins/:id"),
      guarded(({ params }) => {
        const statuses = state.logins.get(params.id);

        if (statuses === undefined) {
          return failure(LoginNotFoundError, new LoginNotFoundError({ id: params.id }), 404);
        }

        const [status = { status: "pending" }, ...rest] = statuses;

        if (rest.length > 0) state.logins.set(params.id, rest);

        // Like via, a login for an account already in the pool gives it fresh tokens
        // and lifts its lockout.
        if (status.status === "updated") {
          state.pool = {
            ...state.pool,
            accounts: state.pool.accounts.map((a) =>
              a.id === status.account.id && a.state.status === "auth_error"
                ? { ...a, state: { status: "available" } }
                : a,
            ),
          };
        }

        if (status.status === "added") {
          const { id, label, enabled } = status.account;
          state.accounts = [...state.accounts, status.account];
          state.pool = {
            ...state.pool,
            accounts: [
              ...state.pool.accounts,
              { id, label, enabled, state: { status: "available" } },
            ],
          };
        }

        return ok(accounts.endpoints.loginStatus, status);
      }),
    ),
    http.patch<{ id: string }>(
      at("/accounts/:id"),
      guarded(async ({ params, request }) => {
        const found = state.accounts.find((a) => a.id === params.id);

        if (found === undefined) {
          return failure(AccountNotFoundError, new AccountNotFoundError({ query: params.id }), 404);
        }

        const patch = Schema.decodeUnknownSync(
          Schema.Struct({
            label: Schema.optional(Schema.String),
            enabled: Schema.optional(Schema.Boolean),
          }),
        )(await request.json());

        const updated = {
          ...found,
          label: patch.label ?? found.label,
          enabled: patch.enabled ?? found.enabled,
        };

        state.accounts = state.accounts.map((a) => (a.id === params.id ? updated : a));

        return ok(accounts.endpoints.update, updated);
      }),
    ),
    http.delete<{ id: string }>(
      at("/accounts/:id"),
      guarded(({ params }) => {
        state.accounts = state.accounts.filter((a) => a.id !== params.id);

        return noContent();
      }),
    ),

    http.get(
      at("/opencode-go/accounts"),
      guarded(() => ok(opencodeGo.endpoints.list, state.opencodeGo)),
    ),
    http.get(
      at("/ollama"),
      guarded(() => ok(ollama.endpoints.get, state.ollama)),
    ),
    http.put(
      at("/ollama"),
      guarded(async ({ request }) => {
        const { address } = Schema.decodeUnknownSync(OllamaAddressBody)(await request.json());

        if (state.ollama?.fromConfig === true) {
          return failure(OllamaNotEditableError, new OllamaNotEditableError(), 409);
        }

        if (!/^https?:\/\/./.test(address.trim())) {
          return failure(
            OllamaAddressInvalidError,
            new OllamaAddressInvalidError({ address }),
            400,
          );
        }

        state.ollama = { address: address.trim(), fromConfig: false };

        return ok(ollama.endpoints.set, state.ollama);
      }),
    ),
    http.delete(
      at("/ollama"),
      guarded(() => {
        state.ollama = null;

        return noContent();
      }),
    ),
    http.post(
      at("/ollama/check"),
      guarded(async ({ request }) => {
        const { address } = Schema.decodeUnknownSync(OllamaAddressBody)(await request.json());
        const found = state.ollamaAt.get(address) ?? { reason: "nothing answered there" };

        return "reason" in found
          ? failure(OllamaUnreachableError, new OllamaUnreachableError(found), 422)
          : ok(ollama.endpoints.check, { address, ...found });
      }),
    ),
    http.post(
      at("/opencode-go/accounts"),
      guarded(async ({ request }) => {
        const { apiKey } = Schema.decodeUnknownSync(Schema.Struct({ apiKey: Schema.String }))(
          await request.json(),
        );

        if (state.refusedKeys.includes(apiKey)) {
          return failure(
            OpencodeGoKeyRejectedError,
            new OpencodeGoKeyRejectedError({ status: 401 }),
            422,
          );
        }

        // The fake keeps only masked keys, so the last four characters stand in for the key.
        const stored = state.opencodeGo.find(({ key }) => key === `…${apiKey.slice(-4)}`);

        if (stored !== undefined) {
          return failure(
            DuplicateOpencodeGoKeyError,
            new DuplicateOpencodeGoKeyError({ label: stored.label }),
            409,
          );
        }

        const added = opencodeGoAccount({
          id: `go-${state.opencodeGo.length + 1}`,
          label: `OpenCode Go …${apiKey.slice(-4)}`,
          key: `…${apiKey.slice(-4)}`,
        });

        state.opencodeGo = [...state.opencodeGo, added];
        state.pool = {
          ...state.pool,
          opencodeGo: [
            ...state.pool.opencodeGo,
            { id: added.id, label: added.label, enabled: true, state: { status: "available" } },
          ],
        };

        return ok(opencodeGo.endpoints.add, added, 201);
      }),
    ),
    http.patch<{ id: string }>(
      at("/opencode-go/accounts/:id"),
      guarded(async ({ params, request }) => {
        const found = state.opencodeGo.find((a) => a.id === params.id);

        if (found === undefined) {
          return failure(
            OpencodeGoAccountNotFoundError,
            new OpencodeGoAccountNotFoundError({ query: params.id }),
            404,
          );
        }

        const patch = Schema.decodeUnknownSync(
          Schema.Struct({
            label: Schema.optional(Schema.String),
            enabled: Schema.optional(Schema.Boolean),
          }),
        )(await request.json());

        const updated = {
          ...found,
          label: patch.label ?? found.label,
          enabled: patch.enabled ?? found.enabled,
        };

        state.opencodeGo = state.opencodeGo.map((a) => (a.id === params.id ? updated : a));

        return ok(opencodeGo.endpoints.update, updated);
      }),
    ),
    http.delete<{ id: string }>(
      at("/opencode-go/accounts/:id"),
      guarded(({ params }) => {
        state.opencodeGo = state.opencodeGo.filter((a) => a.id !== params.id);

        return noContent();
      }),
    ),

    http.get(
      at("/keys"),
      guarded(() => ok(keys.endpoints.list, state.keys)),
    ),
    http.post(
      at("/keys"),
      guarded(async ({ request }) => {
        const { name } = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(
          await request.json(),
        );

        if (state.keys.some((k) => k.name === name)) {
          return failure(DuplicateKeyNameError, new DuplicateKeyNameError({ name }), 409);
        }

        const id = `key-${state.keys.length + 1}`;
        state.keys = [
          ...state.keys,
          { id, name, createdAt: "2026-09-27T12:00:00.000Z", lastUsedAt: null },
        ];

        return ok(keys.endpoints.create, { id, name, key: `via-sk-${id}-0123456789abcdef` }, 201);
      }),
    ),
    http.patch<{ idOrName: string }>(
      at("/keys/:idOrName"),
      guarded(async ({ params, request }) => {
        const found = state.keys.find((k) => k.id === params.idOrName);

        if (found === undefined) {
          return failure(
            KeyNotFoundError,
            new KeyNotFoundError({ idOrName: params.idOrName }),
            404,
          );
        }

        const { name } = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(
          await request.json(),
        );

        if (state.keys.some((k) => k !== found && k.name === name)) {
          return failure(DuplicateKeyNameError, new DuplicateKeyNameError({ name }), 409);
        }

        const renamed = { ...found, name };
        state.keys = state.keys.map((k) => (k === found ? renamed : k));

        return ok(keys.endpoints.rename, renamed);
      }),
    ),
    http.delete<{ idOrName: string }>(
      at("/keys/:idOrName"),
      guarded(({ params }) => {
        const before = state.keys.length;
        state.keys = state.keys.filter((k) => k.id !== params.idOrName);

        return state.keys.length === before
          ? failure(KeyNotFoundError, new KeyNotFoundError({ idOrName: params.idOrName }), 404)
          : noContent();
      }),
    ),

    http.get(
      at("/usage"),
      guarded(() => ok(usage.endpoints.get, state.usage)),
    ),
    http.get(
      at("/pool"),
      guarded(() => ok(pool.endpoints.get, state.pool)),
    ),
    http.get(
      at("/models"),
      guarded(() => ok(models.endpoints.list, state.models)),
    ),

    http.get(
      at("/history/series"),
      guarded(({ request }) => {
        state.historyQueries.push(new URL(request.url).searchParams);

        return ok(history.endpoints.series, state.historySeries);
      }),
    ),
    http.get(
      at("/history/breakdown"),
      guarded(({ request }) => {
        const query = new URL(request.url).searchParams;
        state.historyQueries.push(query);

        return ok(
          history.endpoints.breakdown,
          state.historyBreakdown.get(query.get("groupBy") ?? "") ?? emptyBreakdown,
        );
      }),
    ),
    http.delete(
      at("/history"),
      guarded(() => {
        const deleted = state.historyRequests.length;
        state.historyRequests = [];
        state.historySeries = { points: [] };
        state.historyBreakdown = new Map();

        return ok(history.endpoints.clear, { deleted });
      }),
    ),
    http.get(
      at("/history/requests"),
      guarded(({ request }) => {
        const query = new URL(request.url).searchParams;
        state.historyQueries.push(query);
        const model = query.get("model");
        const limit = Number(query.get("limit") ?? "50");
        const after = query.get("afterId");
        const matching = state.historyRequests.filter((r) => model === null || r.model === model);
        const start = after === null ? 0 : matching.findIndex((r) => r.requestId === after) + 1;
        const page = matching.slice(start, start + limit);
        const last = page.at(-1);

        return ok(history.endpoints.requests, {
          requests: page,
          next:
            start + limit < matching.length && last !== undefined
              ? Option.some({ at: last.at, requestId: last.requestId })
              : Option.none(),
        });
      }),
    ),
  ];
}

const emptyTotals = {
  requests: 0,
  errors: 0,
  measured: 0,
  unmeasured: 0,
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  firstChunkMs: { p50: Option.none(), p95: Option.none() },
  cost: { apiEquivalentUsd: 0, billedUsd: 0, unpriced: [] },
};

const emptyBreakdown: HistoryBreakdown = { groups: [], totals: emptyTotals };
