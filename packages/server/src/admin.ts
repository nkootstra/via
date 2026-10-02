import { AccountNotFoundError, AccountStore } from "@via/codex-auth";
import type { ModelPrice } from "@via/config";
import { KeyStore } from "@via/keys";
import {
  OpencodeGoAccountNotFoundError,
  OpencodeGoAccounts,
  parseOllamaAddress,
  Providers,
} from "@via/providers";
import { OllamaAddressInvalidError } from "@via/providers/errors";
import { createHash } from "node:crypto";
import {
  type Duration,
  Effect,
  Function,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar, OpenApi } from "effect/unstable/httpapi";
import {
  AdminApi,
  AdminAuthorization,
  bearer,
  Forbidden,
  session,
  Unauthorized,
} from "./admin-api.ts";
import { history } from "./admin-history.ts";
import { AdminSessions, SESSION_LIFETIME } from "./admin-sessions.ts";
import {
  hasLiveSession,
  sessionsEnded,
  signOutAll,
  staleSessionCookies,
} from "./session-cookie.ts";
import {
  adminAccounts,
  adminOllama,
  adminOpencodeGo,
  adminOpenrouter,
  adminPool,
  adminUsage,
  type OpencodeGoEnvironment,
  type StateOptions,
  opencodeGoAccount,
  withoutTokens,
} from "./admin-state.ts";
import { adminEvents } from "./admin-events.ts";
import { ModelCatalog } from "./catalog.ts";
import { keepAlive } from "./keep-alive.ts";
import { Logins } from "./logins.ts";
import { RequestLog } from "./request-log.ts";
import { securityHeaders } from "./security-headers.ts";
import { type EmbeddedUi, uiRoutes } from "./ui.ts";

export type { OpencodeGoEnvironment } from "./admin-state.ts";

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

/**
 * Who is signing in, for counting their failed sign-ins: the address the
 * connection came from. Never a header such as `X-Forwarded-For`, which the
 * client could make up; behind a proxy, every sign-in is the proxy's.
 */
const clientOf = (request: HttpServerRequest.HttpServerRequest) =>
  Option.getOrElse(request.remoteAddress, () => "unknown");

/** The bearer key the request carries, unless it carries none. */
const bearerKey = Effect.map(HttpApiBuilder.securityDecode(bearer), (key) =>
  Redacted.value(key) === "" ? Option.none() : Option.some(key),
);

const authorization = Layer.effect(
  AdminAuthorization,
  Effect.gen(function* () {
    const sessions = yield* AdminSessions;

    // The builder tries `bearer`, then `session`, and answers with the last one's error,
    // so `session` decides every request: a bearer key refused because its address is
    // throttled must answer 429, which an error from `bearer` would turn into a 401.
    return AdminAuthorization.of({
      bearer: () => invalid,
      session: (handler) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const key = yield* bearerKey;

          if (Option.isSome(key)) {
            yield* sessions.authorize(key.value, clientOf(request));

            return yield* handler;
          }

          if (!(yield* hasLiveSession(sessions, request))) return yield* invalid;

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
 * over HTTPS, which its `Origin` says even behind a proxy that ends TLS. Its path
 * is `/`, so loading a page under `/ui` sends it too, for the page's state.
 */
const setSessionCookie = (token: Redacted.Redacted<string> | "", maxAge: Duration.Input) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    yield* HttpApiBuilder.securitySetCookie(session, token, {
      httpOnly: true,
      secure: originOf(request)?.protocol === "https:",
      sameSite: "strict",
      path: "/",
      maxAge,
    });
  });

const sessions = HttpApiBuilder.group(AdminApi, "session", (handlers) =>
  Effect.gen(function* () {
    const admin = yield* AdminSessions;

    return handlers
      .handle("signIn", ({ payload, request }) =>
        Effect.flatMap(admin.signIn(payload.key, clientOf(request)), (token) =>
          setSessionCookie(token, SESSION_LIFETIME),
        ),
      )
      .handle("get", () => Effect.void)
      .handle("signOut", () =>
        Effect.gen(function* () {
          yield* signOutAll(admin, yield* HttpServerRequest.HttpServerRequest);
          yield* setSessionCookie("", 0);
        }),
      );
  }),
);

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
      .handle("list", () => adminAccounts)
      .handle("login", () => logins.start())
      .handle("loginStatus", ({ params }) => logins.status(params.id))
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          const store = yield* AccountStore;
          const { id } = yield* byId(params.id);

          if (payload.label !== undefined) yield* store.setLabel(id, payload.label);

          if (payload.enabled !== undefined) yield* store.setEnabled(id, payload.enabled);

          return withoutTokens(yield* store.find(id));
        }).pipe(Effect.catchTag(["FileLockTimeoutError", "PlatformError"], Effect.die)),
      )
      .handle("remove", ({ params }) =>
        Effect.gen(function* () {
          yield* (yield* AccountStore).remove((yield* byId(params.id)).id);
        }).pipe(Effect.catchTag(["FileLockTimeoutError", "PlatformError"], Effect.die)),
      );
  }),
);

/** The OpenCode Go account with id `id`; like the ChatGPT accounts, never by label. */
const opencodeGoById = Effect.fn("admin.opencodeGoById")(function* (id: string) {
  const account = (yield* (yield* OpencodeGoAccounts).list).find((a) => a.id === id);

  return account ?? (yield* new OpencodeGoAccountNotFoundError({ query: id }));
});

// The account file is via's own; one it can't read or write is a bug, not a request error.
/** OpenRouter as just saved: there is one, as saving it succeeded. */
const savedOpenrouter = Effect.flatMap(adminOpenrouter, (saved) =>
  saved === null
    ? // Saving went through, so the settings are there; not finding them is a defect.
      Effect.die("OpenRouter's settings are gone just after saving them")
    : Effect.succeed(saved),
);

/** `address` as via keeps Ollama's, or why it isn't one. */
const ollamaAddress = (address: string) =>
  Option.match(parseOllamaAddress(address), {
    onNone: () => Effect.fail(new OllamaAddressInvalidError({ address })),
    onSome: Effect.succeed,
  });

const ollama = HttpApiBuilder.group(AdminApi, "ollama", (handlers) =>
  handlers
    .handle("get", () => adminOllama)
    .handle("set", ({ payload }) =>
      Effect.gen(function* () {
        const address = yield* ollamaAddress(payload.address);
        yield* (yield* Providers).ollama.set(address);

        return { address, fromConfig: false };
      }),
    )
    .handle("remove", () => Effect.flatMap(Providers, (providers) => providers.ollama.remove))
    .handle("check", ({ payload }) =>
      Effect.gen(function* () {
        const address = yield* ollamaAddress(payload.address);
        const found = yield* (yield* Providers).ollama.check(address);

        return { address, ...found };
      }),
    ),
);

const openrouter = HttpApiBuilder.group(AdminApi, "openrouter", (handlers) =>
  handlers
    .handle("get", () => adminOpenrouter)
    .handle("setKey", ({ payload }) =>
      Effect.flatMap(Providers, (providers) =>
        providers.openrouter.setKey(payload.apiKey).pipe(Effect.andThen(savedOpenrouter)),
      ),
    )
    .handle("setModels", ({ payload }) =>
      Effect.flatMap(Providers, (providers) =>
        providers.openrouter.setModels(payload.models).pipe(Effect.andThen(savedOpenrouter)),
      ),
    )
    .handle("remove", () => Effect.flatMap(Providers, (providers) => providers.openrouter.remove))
    .handle("catalog", () =>
      Effect.flatMap(Providers, (providers) => providers.openrouter.catalog),
    ),
);

const opencodeGo = (environment: OpencodeGoEnvironment | undefined) =>
  HttpApiBuilder.group(AdminApi, "opencodeGo", (handlers) =>
    handlers
      .handle("list", () => adminOpencodeGo(environment))
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
    .handle("rename", ({ params, payload }) =>
      Effect.flatMap(KeyStore, (store) => store.rename(params.idOrName, payload.name)).pipe(
        Effect.catchTag(["CorruptFileError", "FileLockTimeoutError", "PlatformError"], Effect.die),
      ),
    )
    .handle("revoke", ({ params }) =>
      Effect.flatMap(KeyStore, (store) => store.revoke(params.idOrName)).pipe(
        Effect.catchTag(["CorruptFileError", "FileLockTimeoutError", "PlatformError"], Effect.die),
      ),
    ),
);

const usage = HttpApiBuilder.group(AdminApi, "usage", (handlers) =>
  handlers.handle("get", () => adminUsage),
);

const pool = HttpApiBuilder.group(AdminApi, "pool", (handlers) =>
  handlers.handle("get", () => adminPool),
);

const models = HttpApiBuilder.group(AdminApi, "models", (handlers) =>
  handlers.handle("list", () => Effect.flatMap(ModelCatalog, (catalog) => catalog.list)),
);

/**
 * Answered raw, to keep a quiet stream alive with comments, which the typed events can't
 * carry. A stream opened with the admin key runs until the page goes away; one opened with
 * a session ends with the session too, so a signed-out page stops getting the state.
 */
const events = (options: StateOptions) =>
  HttpApiBuilder.group(AdminApi, "events", (handlers) =>
    Effect.gen(function* () {
      const stream = adminEvents(options);
      const context = yield* Effect.context<Stream.Services<typeof stream>>();
      const admin = yield* AdminSessions;

      return handlers.handleRaw("stream", () =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;

          // Let through with a bearer key, it was the admin key.
          const ended = Option.isSome(yield* bearerKey)
            ? Effect.never
            : sessionsEnded(admin, request);

          const body = (yield* RequestLog).timed(keepAlive(Stream.interruptWhen(stream, ended)));

          return HttpServerResponse.stream(Stream.provideContext(body, context), {
            contentType: "text/event-stream",
            headers: { "cache-control": "no-store" },
          });
        }),
      );
    }),
  );

/**
 * The reference page shows the spec with little else: system fonts rather than
 * Scalar's web fonts, and no Open API Client button or developer toolbar. Each
 * route's Test Request button still opens the client, to try it out. Effect's
 * `ScalarConfig` type lacks the last two options, but it hands every key to
 * Scalar, whose bundled version supports them.
 */
const scalarConfig = {
  withDefaultFonts: false,
  hideClientButton: true,
  showDeveloperTools: "never",
};

/** The CSP source (`'sha256-…'`) of each inline script in `html`. */
const inlineScriptHashes = (html: string) =>
  Array.from(
    html.matchAll(/<script>([\s\S]*?)<\/script>/g),
    ([, script = ""]) => `'sha256-${createHash("sha256").update(script).digest("base64")}'`,
  );

/**
 * The reference page with its headers. Its CSP lets it run only its own two
 * inline scripts, Scalar's and the one that starts it, whose hashes are taken
 * from the page itself; style itself inline, as Scalar does; and send its test
 * requests only to via. The page is built once, so this runs once too.
 */
const securedPage = Function.memoize((page: HttpServerResponse.HttpServerResponse) => {
  const { body } = page;

  const html =
    Predicate.hasProperty(body, "body") && Predicate.isUint8Array(body.body)
      ? new TextDecoder().decode(body.body)
      : "";

  return HttpServerResponse.setHeaders(
    page,
    securityHeaders([
      `script-src ${inlineScriptHashes(html).join(" ")}`,
      "style-src 'unsafe-inline'",
      "img-src data:",
      "connect-src 'self'",
    ]),
  );
});

const referenceHeaders = HttpRouter.middleware((page) => Effect.map(page, securedPage));

/**
 * The admin API under `/admin`, behind `adminKey` (`VIA_ADMIN_KEY`), and with `ui`,
 * the admin UI at `/ui`, whose signed-in pages share the API's sessions. Without
 * that key neither is registered at all, so both answer 404 like any unknown path.
 * The API's OpenAPI spec and a Scalar reference page for it need no key.
 */
export const adminRoutes = ({
  adminKey,
  ui,
  opencodeGoEnvironment,
  version,
  prices,
}: {
  readonly adminKey: Redacted.Redacted<string> | undefined;
  readonly ui: EmbeddedUi | undefined;
  readonly opencodeGoEnvironment: OpencodeGoEnvironment | undefined;
  readonly version: string;
  readonly prices: Readonly<Record<string, ModelPrice>>;
}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (adminKey === undefined) return Layer.empty;
      const { length } = Redacted.value(adminKey);

      if (length < 32) return yield* new AdminKeyTooShortError({ length });

      return Layer.mergeAll(
        HttpApiBuilder.layer(AdminApi).pipe(
          Layer.provide([
            sessions,
            accounts,
            opencodeGo(opencodeGoEnvironment),
            ollama,
            openrouter,
            keys,
            usage,
            history(prices),
            pool,
            models,
            events({ environment: opencodeGoEnvironment, version }),
          ]),
          Layer.provide([authorization, Logins.layer]),
        ),
        HttpRouter.add(
          "GET",
          "/admin/openapi.json",
          HttpServerResponse.jsonUnsafe(OpenApi.fromApi(AdminApi), {
            headers: securityHeaders([]),
          }),
        ),
        // Scalar's script is served inline rather than from a CDN: the page is where
        // the admin key gets typed in, so it runs no third-party code.
        HttpApiScalar.layer(AdminApi, { path: "/admin/docs", scalar: scalarConfig }).pipe(
          Layer.provide(referenceHeaders.layer),
        ),
        ui === undefined
          ? Layer.empty
          : uiRoutes(ui, { environment: opencodeGoEnvironment, version }),
        staleSessionCookies,
      ).pipe(Layer.provide(AdminSessions.layer(adminKey)));
    }),
  );
