import { createKey, type SeededAccount, seedAccounts, serveVia, viaHome } from "@via/cli/testing";
import type { FakeIssuerOptions } from "@via/codex-auth/testing";
import {
  type CodexRequest,
  codexErrorFixture,
  type FakeCodex,
  reply,
  startFakeCodex,
} from "@via/codex-upstream/testing";
import { Effect, Predicate, Schema } from "effect";
import OpenAI from "openai";

export { freePort, realTime, runVia, tempHome } from "@via/cli/testing";

/** The fake Codex backend, scoped; point via at `codex.url`. */
export const startCodex = startFakeCodex;

export type Codex = FakeCodex;

export type Via = {
  home: string;
  url: string;
  key: string;
  env: Record<string, string>;
};

/**
 * Starts a `via serve` with one API key, for as long as the test's scope,
 * sending upstream traffic to `upstream`. Its pool is one account logged in
 * through the fake issuer (`dev@example.com`, `acc-123`), or `accounts` when given.
 */
export const launchVia = (options: {
  upstream: string;
  /** Seed these accounts instead of logging one in through the fake issuer. */
  accounts?: ReadonlyArray<SeededAccount>;
  issuer?: FakeIssuerOptions;
  /** More environment for every `via` command, `via serve` included. */
  env?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { home, env, via } = yield* viaHome(options);

    if (options.accounts === undefined) yield* via("accounts", "add");
    else yield* seedAccounts(home, options.accounts);
    const key = yield* createKey(home, "e2e");
    // Port 0 lets the OS pick a free port; via reports the one it got.
    const url = yield* serveVia(home, ["--port", "0"], env);

    return { home, url, key, env } satisfies Via;
  });

/** The official SDK, pointed at via. */
export const openai = (via: Via) =>
  new OpenAI({ baseURL: `${via.url}/v1`, apiKey: via.key, maxRetries: 0 });

/** A chat completion for `content` through the SDK. */
export const chat = (via: Via, content: string) =>
  Effect.promise(() =>
    openai(via).chat.completions.create({
      model: "gpt-6-astra",
      messages: [{ role: "user", content }],
    }),
  );

/**
 * POSTs `body` to via with its API key, for what the SDK hides or can't send:
 * an object goes as JSON, a string as it is.
 */
export const post = (
  via: Via,
  path: string,
  body: Schema.JsonObject | string,
  signal?: AbortSignal,
) =>
  Effect.promise(() =>
    fetch(`${via.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${via.key}` },
      body: Predicate.isString(body) ? body : JSON.stringify(body),
      ...(signal !== undefined && { signal }),
    }),
  );

/** Decodes one JSON text, such as an SSE `data` line, with `schema`. */
export const decodeJson = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema));

/** A response's JSON body. */
export const json = (response: Response) => Effect.promise(() => response.json());

/** The Responses requests Codex received, in order, leaving out usage lookups. */
export const responsesOf = (codex: Codex): ReadonlyArray<CodexRequest> =>
  codex.requests.filter((request) => request.path === "/codex/responses");

/** One of codex's recorded error answers, verbatim, as a reply. */
export const errorFixture = (name: string) =>
  Effect.map(codexErrorFixture(name), ({ status, headers, body }) =>
    reply.error(status, body, headers),
  );
