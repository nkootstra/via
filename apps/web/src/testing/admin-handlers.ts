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
import { Schema } from "effect";
import type { Account, Key, LoginStatus, Model, Pool, Usage } from "../api/types.ts";
import { http, HttpResponse, type JsonBodyType, type PathParams } from "msw";

const { accounts, keys, usage, pool, models } = AdminApi.groups;

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
}

export const account = (fields: Partial<Account> & Pick<Account, "id" | "label">): Account => ({
  email: `${fields.label}@example.com`,
  plan: "plus",
  enabled: true,
  createdAt: "2026-09-01T10:00:00.000Z",
  ...fields,
});

export function createAdminState(seed: Partial<AdminState> = {}): AdminState {
  return {
    signedIn: true,
    adminKey: "the-admin-key",
    accounts: [],
    keys: [],
    logins: new Map(),
    nextLogin: [{ status: "pending" }],
    pool: { accounts: [], providers: [] },
    usage: { accounts: [], providers: [], refreshing: false },
    models: [],
    requests: [],
    ...seed,
  };
}

const at = (path: string) => `*/admin${path}`;

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

        if (status.status === "added") state.accounts = [...state.accounts, status.account];

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
        state.keys = [...state.keys, { id, name, createdAt: "2026-09-27T12:00:00.000Z" }];

        return ok(keys.endpoints.create, { id, name, key: `via-sk-${id}-0123456789abcdef` }, 201);
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
  ];
}
