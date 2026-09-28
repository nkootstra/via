import { BunFileSystem, BunHttpServer } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Deferred, type Duration, Effect, Fiber, FileSystem, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { OpencodeGoAccounts, Providers } from "./index.ts";

/** A server that takes every request and never answers; `arrived` waits for the first. */
const startSilentServer = Effect.gen(function* () {
  const arrived = yield* Deferred.make<void>();

  const server = yield* Layer.build(
    HttpRouter.serve(
      HttpRouter.add(
        "*",
        "*",
        Deferred.succeed(arrived, undefined).pipe(Effect.andThen(Effect.never)),
      ),
    ).pipe(Layer.provideMerge(BunHttpServer.layer({ port: 0, idleTimeout: 0 }))),
  );

  const url = yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(Effect.provide(server));

  return { url, arrived: Deferred.await(arrived) };
});

const key = Redacted.make("sk-test");

/**
 * Runs `call` against providers served by a server that never answers, moves
 * test time on by `limit` once the request has arrived, and answers how it ended.
 */
const againstSilence = <A, E>(
  limit: Duration.Input,
  call: (providers: Providers["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const silent = yield* startSilentServer;
    const fs = yield* FileSystem.FileSystem;
    const accounts = OpencodeGoAccounts.layer(`${yield* fs.makeTempDirectoryScoped()}/go.json`);
    const config = { baseUrl: silent.url, apiKeyEnv: "LOCAL_KEY" };

    const running = yield* Effect.flatMap(Providers, (providers) =>
      Effect.exit(call(providers)),
    ).pipe(
      Effect.provide(
        Providers.layer({
          providers: { local: config, "opencode-go": config },
          apiKeys: { local: key },
          version: "1.2.3",
        }).pipe(Layer.provide([FetchHttpClient.layer, accounts])),
      ),
      Effect.forkChild,
    );

    yield* silent.arrived;
    yield* TestClock.adjust(limit);

    return yield* Fiber.join(running);
  });

layer(BunFileSystem.layer)("Providers against a provider that never answers", (it) => {
  it.effect("lists no models from it after 30 seconds", () =>
    Effect.gen(function* () {
      const listed = yield* againstSilence("30 seconds", (providers) => providers.models);
      expect(listed).toMatchObject({ _tag: "Success", value: [] });
    }),
  );

  it.effect("reports its usage unavailable after 30 seconds", () =>
    Effect.gen(function* () {
      const usage = yield* againstSilence("30 seconds", (providers) => providers.usage(key));

      expect(usage).toMatchObject({
        _tag: "Success",
        value: { provider: "opencode-go", error: expect.stringContaining("no answer within 30s") },
      });
    }),
  );

  it.effect("fails to verify a key after 30 seconds, as unreachable", () =>
    Effect.gen(function* () {
      const verified = yield* againstSilence("30 seconds", (providers) => providers.verify(key));

      expect(verified).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ error: { _tag: "OpencodeGoUnavailableError" } }] },
      });
    }),
  );

  it.effect("gives up on a request it has not started answering after 10 minutes", () =>
    Effect.gen(function* () {
      const sent = yield* againstSilence("10 minutes", (providers) =>
        providers.send(
          { provider: "local", model: "m", pooled: false },
          "/chat/completions",
          { messages: [] },
          "session-1",
        ),
      );

      expect(sent).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ error: { _tag: "HttpClientError" } }] },
      });
    }),
  );
});
