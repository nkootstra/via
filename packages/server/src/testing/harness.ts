// Test-only: runs a real via server against fake Codex and auth.openai.com servers.
import { BunFileSystem, BunHttpServer } from "@effect/platform-bun";
import { AccountPool, UsageSnapshots } from "@via/account-pool";
import { AccountStore, AccountTokens, CodexAuth } from "@via/codex-auth";
import {
  type FakeIssuerOptions,
  refreshedTokens,
  startFakeIssuer,
  tokensFor,
} from "@via/codex-auth/testing";
import { CodexUpstream } from "@via/codex-upstream";
import {
  type CodexRequest,
  completedStream,
  type Reply,
  reply,
  startFakeCodex,
} from "@via/codex-upstream/testing";
import { KeyStore } from "@via/keys";
import { PoolStates } from "@via/pool";
import { OpencodeGoAccounts, OpencodeGoPool, Providers } from "@via/providers";
import { type FakeProvider, startFakeProvider } from "@via/providers/testing";
import {
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Redacted,
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
import { ViaServer } from "../index.ts";
import type { EmbeddedUi } from "../ui.ts";

/** Codex's answer to a request that goes well: "hello", as a completed stream. */
export const ok = () => reply.sse(completedStream("hello"));

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
    headers?: Record<string, string>,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown>;
  /** PATCHes JSON to the via server, with a valid API key unless `key` says otherwise. */
  readonly patch: (
    path: string,
    body: Schema.Json,
    key?: string | null,
    headers?: Record<string, string>,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown>;
  /** DELETEs a path on the via server, with a valid API key unless `key` says otherwise. */
  readonly delete: (
    path: string,
    key?: string | null,
    headers?: Record<string, string>,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown>;
  /** The via server's URL, e.g. `http://127.0.0.1:1234`. */
  readonly baseUrl: string;
  /** A valid API key. */
  readonly key: string;
  /** Every request the fake Codex received so far. */
  readonly upstreamRequests: ReadonlyArray<CodexRequest>;
  /** Sets an account's `/wham/usage` answer on the fake Codex, by ChatGPT account id. */
  readonly codexUsage: (account: string, body: Schema.Json, status?: number) => void;
  /**
   * The fake provider behind both `openrouter/` and `opencode-go/` models;
   * OpenRouter's key is `sk-provider`, and OpenCode Go's are its accounts'.
   */
  readonly provider: FakeProvider;
  /** Waits for the first line via logs whose message or annotations contain `text`. */
  readonly logged: (text: string) => Effect.Effect<LogLine>;
  /** Every line via logged so far. */
  readonly logs: ReadonlyArray<LogLine>;
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

  return { logger, logged, lines };
};

/**
 * Starts via with accounts "a" and "b" (in that order) and a fresh API key.
 * The fake Codex answers each request with `answer`'s reply; the fake issuer answers the
 * first refresh with `refreshResponse`, by default a new access token. Account "a"'s
 * access token expires at `aExpiresAt`, by default far in the future. With
 * `codexUrl`, via sends Codex traffic there instead of to the fake Codex.
 * Models prefixed `openrouter/` and `opencode-go/` go to a fake provider, or
 * to `providerUrl` when it is given; OpenCode Go has an account for each of
 * `opencodeGoKeys`, labelled `go-1`, `go-2` and so on, and `opencodeGoVariable`
 * says which key its deprecated environment variable still holds. With `adminKey`, via serves the admin API
 * behind that key, and with `ui` as well, the admin UI. Device-code logins
 * go to the fake issuer, with its `pendingPolls` and `interval`.
 */
export const withVia = <A, E>(
  answer: (request: CodexRequest) => Reply,
  body: (via: Via) => Effect.Effect<A, E>,
  {
    refreshResponse = {
      status: 200,
      // Without an id token, so each refreshed account keeps its own identity.
      body: {
        access_token: refreshedTokens.access_token,
        refresh_token: refreshedTokens.refresh_token,
      },
    },
    aExpiresAt,
    codexUrl,
    providerUrl,
    adminKey,
    ui,
    pendingPolls = 0,
    interval = "0",
    opencodeGoKeys = ["sk-provider"],
    opencodeGoVariable,
  }: Pick<FakeIssuerOptions, "refreshResponse" | "pendingPolls" | "interval"> & {
    aExpiresAt?: number;
    opencodeGoKeys?: ReadonlyArray<string>;
    opencodeGoVariable?: { variable: string; apiKey: string };
    codexUrl?: string;
    providerUrl?: string;
    adminKey?: string;
    ui?: EmbeddedUi;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();

    const stores = Layer.mergeAll(
      KeyStore.layer(`${dir}/keys.json`),
      AccountStore.layer(`${dir}/auth`),
      OpencodeGoAccounts.layer(`${dir}/opencode-go.json`),
    ).pipe(Layer.provide(BunFileSystem.layer));

    const codex = yield* startFakeCodex;
    codex.respond(answer);
    const issuer = yield* startFakeIssuer({ refreshResponse, pendingPolls, interval });
    const provider = yield* startFakeProvider;
    const providerConfig = { baseUrl: providerUrl ?? provider.url, apiKeyEnv: "PROVIDER_KEY" };
    const providerKey = Redacted.make("sk-provider");

    const services = Layer.mergeAll(
      AccountTokens.layer.pipe(
        Layer.provideMerge(CodexAuth.layer(issuer)),
        Layer.provideMerge(stores),
      ),
      CodexUpstream.layer({
        baseUrl: codexUrl ?? codex.url,
        cloak: true,
        version: "0.0.0",
      }),
      Providers.layer({
        providers: { openrouter: providerConfig, "opencode-go": providerConfig },
        apiKeys: { openrouter: providerKey },
        version: "0.0.0",
      }).pipe(Layer.provideMerge(stores)),
    ).pipe(Layer.provide(FetchHttpClient.layer));

    // The accounts exist before via starts, as they do for `via serve`.
    const built = yield* Layer.build(services);
    yield* Effect.gen(function* () {
      const store = yield* AccountStore;
      yield* store.save(tokensFor("a", aExpiresAt === undefined ? {} : { expiresAt: aExpiresAt }));
      // Accounts are used in the order they were added, so "a" must come first.
      yield* TestClock.adjust("1 second");
      yield* store.save(tokensFor("b"));
      // And an account a test adds comes after both: the list is ordered by when each
      // was added, and one added at the same instant as "b" would sort by file order.
      yield* TestClock.adjust("1 second");
      const opencodeGo = yield* OpencodeGoAccounts;

      for (const [index, apiKey] of opencodeGoKeys.entries()) {
        yield* TestClock.adjust("1 second");
        yield* opencodeGo.add(Redacted.make(apiKey), `go-${index + 1}`);
      }
    }).pipe(Effect.provide(built));
    const logs = collectLogs();

    const server = yield* Layer.build(
      ViaServer.layer({
        adminKey: adminKey === undefined ? undefined : Redacted.make(adminKey),
        ui,
        opencodeGoEnvironment:
          opencodeGoVariable === undefined
            ? undefined
            : {
                variable: opencodeGoVariable.variable,
                apiKey: Redacted.make(opencodeGoVariable.apiKey),
              },
      }).pipe(
        Layer.provide(Layer.mergeAll(AccountPool.layer, OpencodeGoPool.layer)),
        Layer.provide(UsageSnapshots.layer),
        Layer.provide(Logger.layer([logs.logger])),
        Layer.provide(PoolStates.layer),
        Layer.provide(BunFileSystem.layer),
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

      const get: Via["get"] = (path, override, headers = {}) =>
        HttpClientRequest.get(`${base}${path}`).pipe(
          authorize(override),
          HttpClientRequest.setHeaders(headers),
          http.execute,
        );

      const patch: Via["patch"] = (path, json, override, headers = {}) =>
        HttpClientRequest.patch(`${base}${path}`).pipe(
          authorize(override),
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bodyJsonUnsafe(json),
          http.execute,
        );

      const del: Via["delete"] = (path, override, headers = {}) =>
        HttpClientRequest.delete(`${base}${path}`).pipe(
          authorize(override),
          HttpClientRequest.setHeaders(headers),
          http.execute,
        );

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
        logs: logs.lines,
      });
    }).pipe(Effect.provide(server), Effect.provide(FetchHttpClient.layer));
  });
