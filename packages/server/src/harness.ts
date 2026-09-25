// Test-only: runs a real via server against fake Codex and auth.openai.com servers.
import { BunFileSystem, BunHttpServer } from "@effect/platform-bun";
import { AccountStore, AccountTokens, CodexAuth } from "@via/codex-auth";
import { type FakeIssuerOptions, fakeIssuer, jwt } from "@via/codex-auth/testing";
import { CodexUpstream } from "@via/codex-upstream";
import { type FakeReply, fakeUpstream, type RecordedRequest } from "@via/codex-upstream/testing";
import { KeyStore } from "@via/keys";
import { Effect, FileSystem, Layer } from "effect";
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
export const accountTokens = (name: string, expiresAt = 1e15) => ({
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
    body: object,
    key?: string | null,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown>;
  /** GETs a path from the via server, with a valid API key unless `key` says otherwise. */
  readonly get: (
    path: string,
    key?: string | null,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown>;
  /** The via server's URL, e.g. `http://127.0.0.1:1234`. */
  readonly baseUrl: string;
  /** A valid API key. */
  readonly key: string;
  /** Every request the fake Codex upstream received so far. */
  readonly upstreamRequests: ReadonlyArray<RecordedRequest>;
};

/**
 * Starts via with accounts "a" and "b" (in that order) and a fresh API key.
 * The fake upstream answers each request with `reply`; the fake issuer answers the
 * first refresh with `refreshResponse`, by default a new access token. Account "a"'s
 * access token expires at `aExpiresAt`, by default far in the future. With
 * `codexUrl`, via sends Codex traffic there instead of to the fake upstream.
 */
export const withVia = <A, E>(
  reply: (request: RecordedRequest) => FakeReply,
  body: (via: Via) => Effect.Effect<A, E>,
  {
    refreshResponse = {
      status: 200,
      body: { access_token: refreshedAccessToken, refresh_token: "rt-2" },
    },
    aExpiresAt,
    codexUrl,
  }: Pick<FakeIssuerOptions, "refreshResponse"> & {
    aExpiresAt?: number;
    codexUrl?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const stores = Layer.mergeAll(
      KeyStore.layer(`${dir}/keys.json`),
      AccountStore.layer(`${dir}/auth`),
    ).pipe(Layer.provide(BunFileSystem.layer));

    const upstreamRequests: Array<RecordedRequest> = [];
    const upstream = yield* Layer.build(
      fakeUpstream((request) => {
        upstreamRequests.push(request);
        return reply(request);
      }),
    );
    const issuer = yield* Layer.build(fakeIssuer({ refreshResponse }));
    const address = (context: typeof upstream | typeof issuer) =>
      HttpServer.addressFormattedWith(Effect.succeed).pipe(Effect.provide(context));

    const services = Layer.mergeAll(
      AccountTokens.layer.pipe(
        Layer.provide(CodexAuth.layer(yield* address(issuer))),
        Layer.provideMerge(stores),
      ),
      CodexUpstream.layer({
        baseUrl: codexUrl ?? (yield* address(upstream)),
        cloak: true,
      }),
    ).pipe(Layer.provide(FetchHttpClient.layer));

    const server = yield* Layer.build(
      ViaServer.layer.pipe(
        Layer.provideMerge(BunHttpServer.layer({ port: 0 })),
        Layer.provideMerge(services),
      ),
    );

    return yield* Effect.gen(function* () {
      const store = yield* AccountStore;
      yield* store.save(accountTokens("a", aExpiresAt));
      // Accounts are used in the order they were added, so "a" must come first.
      yield* TestClock.adjust("1 second");
      yield* store.save(accountTokens("b"));
      const { key } = yield* (yield* KeyStore).create("test");
      const base = yield* HttpServer.addressFormattedWith(Effect.succeed);
      const http = yield* HttpClient.HttpClient;
      const authorize = (override: string | null | undefined) =>
        override === null
          ? (request: HttpClientRequest.HttpClientRequest) => request
          : HttpClientRequest.bearerToken(override ?? key);
      const post: Via["post"] = (path, json, override) =>
        HttpClientRequest.post(`${base}${path}`).pipe(
          authorize(override),
          HttpClientRequest.bodyJsonUnsafe(json),
          http.execute,
        );
      const get: Via["get"] = (path, override) =>
        http.execute(HttpClientRequest.get(`${base}${path}`).pipe(authorize(override)));
      return yield* body({ post, get, baseUrl: base, key, upstreamRequests });
    }).pipe(Effect.provide(server), Effect.provide(FetchHttpClient.layer));
  });
