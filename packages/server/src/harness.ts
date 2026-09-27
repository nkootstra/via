// Test-only: runs a real via server against fake Codex and auth.openai.com servers.
import { BunFileSystem, BunHttpServer } from "@effect/platform-bun";
import { AccountStore, AccountTokens, CodexAuth } from "@via/codex-auth";
import { type FakeIssuerOptions, fakeIssuer, jwt } from "@via/codex-auth/testing";
import { CodexUpstream } from "@via/codex-upstream";
import { type CodexRequest, type Reply, startFakeCodex } from "@via/codex-upstream/testing";
import { KeyStore } from "@via/keys";
import { PoolStates } from "@via/pool";
import { Providers } from "@via/providers";
import { type FakeProvider, startFakeProvider } from "@via/providers/testing";
import {
  ConfigProvider,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Logger,
  References,
  type Schema,
} from "effect";
import { TestClock } from "effect/testing";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServer,
} from "effect/unstable/http";
import { ViaServer } from "./index.ts";

/** The access token the fake issuer hands out when any account refreshes. */
export const refreshedAccessToken = jwt({
  exp: 2_000_000_000,
  refreshed: true,
});

/** Tokens for a ChatGPT account named `name`, valid far into the future. */
const accountTokens = (name: string, expiresAt = 1e15) => ({
  idToken: jwt({
    email: `${name}@example.com`,
    "https://api.openai.com/auth": {
      chatgpt_account_id: `acc-${name}`,
      chatgpt_plan_type: "pro",
    },
  }),
  accessToken: `at-${name}`,
  refreshToken: "rt-1",
  expiresAt,
});

export type Via = {
  /** POSTs JSON to the via server, with a valid API key unless `key` says otherwise. */
  readonly post: (
    path: string,
    body: Schema.Json,
    key?: string | null,
    headers?: Record<string, string | ReadonlyArray<string>>,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown>;
  /** GETs a path from the via server, with a valid API key unless `key` says otherwise. */
  readonly get: (
    path: string,
    key?: string | null,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown>;
  /** PATCHes JSON to the via server, with a valid API key unless `key` says otherwise. */
  readonly patch: (
    path: string,
    body: Schema.Json,
    key?: string | null,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown>;
  /** DELETEs a path on the via server, with a valid API key unless `key` says otherwise. */
  readonly delete: (
    path: string,
    key?: string | null,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown>;
  /** The via server's URL, e.g. `http://127.0.0.1:1234`. */
  readonly baseUrl: string;
  /** A valid API key. */
  readonly key: string;
  /** Every request the fake Codex received so far. */
  readonly upstreamRequests: ReadonlyArray<CodexRequest>;
  /** Sets an account's `/wham/usage` answer on the fake Codex, by ChatGPT account id. */
  readonly codexUsage: (account: string, body: Schema.Json, status?: number) => void;
  /** The fake provider behind both `openrouter/` and `opencode-go/` models. */
  readonly provider: FakeProvider;
  /** Waits for the first line via logs whose message or annotations contain `text`. */
  readonly logged: (text: string) => Effect.Effect<LogLine>;
};

/** A line via logged, with the labels of its log spans. */
type LogLine = {
  readonly level: string;
  readonly message: string;
  readonly spans: ReadonlyArray<string>;
  readonly annotations: typeof References.CurrentLogAnnotations.Service;
};

/** A logger that keeps every line, and `logged(text)`, which waits for one containing `text`. */
const collectLogs = () => {
  const lines: Array<LogLine> = [];
  const waiters: Array<{ text: string; line: Deferred.Deferred<LogLine> }> = [];

  const matches = (line: LogLine, text: string) =>
    `${line.message} ${JSON.stringify(line.annotations)}`.includes(text);

  const logger = Logger.make(({ logLevel, message, fiber }) => {
    const line: LogLine = {
      level: logLevel,
      message: (Array.isArray(message) ? message : [message]).join(" "),
      spans: fiber.getRef(References.CurrentLogSpans).map(([label]) => label),
      annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
    };

    lines.push(line);

    for (const waiter of waiters.filter(({ text }) => matches(line, text))) {
      Deferred.doneUnsafe(waiter.line, Effect.succeed(line));
    }
  });

  const logged = (text: string) =>
    Effect.suspend(() => {
      const line = lines.find((seen) => matches(seen, text));

      if (line !== undefined) return Effect.succeed(line);
      const waiter = { text, line: Deferred.makeUnsafe<LogLine>() };
      waiters.push(waiter);

      return Deferred.await(waiter.line);
    });

  return { logger, logged };
};

/**
 * Starts via with accounts "a" and "b" (in that order) and a fresh API key.
 * The fake Codex answers each request with `answer`'s reply; the fake issuer answers the
 * first refresh with `refreshResponse`, by default a new access token. Account "a"'s
 * access token expires at `aExpiresAt`, by default far in the future. With
 * `codexUrl`, via sends Codex traffic there instead of to the fake Codex.
 * Models prefixed `openrouter/` and `opencode-go/` go to a fake provider, or
 * to `providerUrl` when it is given. With `adminKey`, via serves the admin API
 * behind that key; the environment's `VIA_ADMIN_KEY` is never read. Device-code logins
 * go to the fake issuer, with its `pendingPolls` and `interval`.
 */
export const withVia = <A, E>(
  answer: (request: CodexRequest) => Reply,
  body: (via: Via) => Effect.Effect<A, E>,
  {
    refreshResponse = {
      status: 200,
      body: { access_token: refreshedAccessToken, refresh_token: "rt-2" },
    },
    aExpiresAt,
    codexUrl,
    providerUrl,
    adminKey,
    pendingPolls = 0,
    interval = "0",
  }: Pick<FakeIssuerOptions, "refreshResponse" | "pendingPolls" | "interval"> & {
    aExpiresAt?: number;
    codexUrl?: string;
    providerUrl?: string;
    adminKey?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();

    const stores = Layer.mergeAll(
      KeyStore.layer(`${dir}/keys.json`),
      AccountStore.layer(`${dir}/auth`),
    ).pipe(Layer.provide(BunFileSystem.layer));

    const codex = yield* startFakeCodex;
    codex.respond(answer);
    const issuer = yield* Layer.build(fakeIssuer({ refreshResponse, pendingPolls, interval }));
    const provider = yield* startFakeProvider;
    const providerConfig = { baseUrl: providerUrl ?? provider.url, apiKeyEnv: "PROVIDER_KEY" };

    const services = Layer.mergeAll(
      AccountTokens.layer.pipe(
        Layer.provideMerge(
          CodexAuth.layer(
            yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(Effect.provide(issuer)),
          ),
        ),
        Layer.provideMerge(stores),
      ),
      CodexUpstream.layer({
        baseUrl: codexUrl ?? codex.url,
        cloak: true,
        version: "0.0.0",
      }),
      Providers.layer({ openrouter: providerConfig, "opencode-go": providerConfig }, "0.0.0").pipe(
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ PROVIDER_KEY: "sk-provider" })),
        ),
      ),
    ).pipe(Layer.provide(FetchHttpClient.layer));

    // The accounts exist before via starts, as they do for `via serve`.
    const built = yield* Layer.build(services);
    yield* Effect.gen(function* () {
      const store = yield* AccountStore;
      yield* store.save(accountTokens("a", aExpiresAt));
      // Accounts are used in the order they were added, so "a" must come first.
      yield* TestClock.adjust("1 second");
      yield* store.save(accountTokens("b"));
    }).pipe(Effect.provide(built));
    const logs = collectLogs();

    const server = yield* Layer.build(
      ViaServer.layer.pipe(
        Layer.provide(Logger.layer([logs.logger])),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown(adminKey === undefined ? {} : { VIA_ADMIN_KEY: adminKey }),
          ),
        ),
        Layer.provide(PoolStates.layer),
        Layer.provideMerge(BunHttpServer.layer({ port: 0 })),
        Layer.provideMerge(Layer.succeedContext(built)),
      ),
    );

    return yield* Effect.gen(function* () {
      const { key } = yield* (yield* KeyStore).create("test");
      const base = yield* HttpServer.addressFormattedWith(Effect.succeed);
      const http = yield* HttpClient.HttpClient;

      const authorize = (override: string | null | undefined) =>
        override === null
          ? (request: HttpClientRequest.HttpClientRequest) => request
          : HttpClientRequest.bearerToken(override ?? key);

      const post: Via["post"] = (path, json, override, headers = {}) =>
        HttpClientRequest.post(`${base}${path}`).pipe(
          authorize(override),
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bodyJsonUnsafe(json),
          http.execute,
        );

      const get: Via["get"] = (path, override) =>
        http.execute(HttpClientRequest.get(`${base}${path}`).pipe(authorize(override)));

      const patch: Via["patch"] = (path, json, override) =>
        HttpClientRequest.patch(`${base}${path}`).pipe(
          authorize(override),
          HttpClientRequest.bodyJsonUnsafe(json),
          http.execute,
        );

      const del: Via["delete"] = (path, override) =>
        http.execute(HttpClientRequest.delete(`${base}${path}`).pipe(authorize(override)));

      return yield* body({
        post,
        get,
        patch,
        delete: del,
        baseUrl: base,
        key,
        upstreamRequests: codex.requests,
        codexUsage: codex.usage,
        provider,
        logged: logs.logged,
      });
    }).pipe(Effect.provide(server), Effect.provide(FetchHttpClient.layer));
  });
