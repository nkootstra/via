import { BunFileSystem, BunHttpServer } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { fakeIssuer } from "@via/codex-auth/testing";
import { type FakeCodex, reply, startFakeCodex } from "@via/codex-upstream/testing";
import { providerReply, startFakeProvider } from "@via/providers/testing";
import { Deferred, Effect, Exit, FileSystem, Layer, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { freePort, realTime, runVia, serveVia, startVia, tempHome } from "./helpers.ts";

/**
 * A `via` home with one account (from a fake issuer) and one API key, whose
 * upstream is a fake Codex backend that answers "hello" unless scripted otherwise.
 */
const withHome = <A, E, R>(
  body: (setup: {
    home: string;
    key: string;
    env: Record<string, string>;
    codex: FakeCodex;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const home = yield* tempHome;
    const codex = yield* startFakeCodex;
    codex.respond(() => reply.text("hello"));
    const issuer = yield* Layer.build(fakeIssuer());

    const env = {
      VIA_CODEX_ISSUER: yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(
        Effect.provide(issuer),
      ),
      VIA_CODEX_BASE_URL: codex.url,
    };

    yield* runVia(home, ["accounts", "add"], env);
    const created = yield* runVia(home, ["keys", "create", "--name", "test"]);
    const key = created.stdout.trim().split("\n").at(-1) ?? "";

    return yield* body({ home, key, env, codex });
  });

const postResponses = (url: string, key: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;

    return yield* HttpClientRequest.post(`${url}/v1/responses`).pipe(
      HttpClientRequest.bearerToken(key),
      HttpClientRequest.bodyJsonUnsafe({ model: "gpt-6-astra", input: "hi" }),
      http.execute,
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));

const Traces = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      scopeSpans: Schema.Array(
        Schema.Struct({ spans: Schema.Array(Schema.Struct({ name: Schema.String })) }),
      ),
    }),
  ),
});

/** A local OTLP/HTTP collector; `saw(name)` waits until a span called `name` arrives. */
const startCollector = Effect.gen(function* () {
  const names = new Set<string>();
  const waiters: Array<{ name: string; seen: Deferred.Deferred<void> }> = [];

  const receive = HttpServerRequest.schemaBodyJson(Traces).pipe(
    Effect.tap((traces) =>
      Effect.forEach(
        traces.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) => scope.spans.map((span) => span.name)),
        ),
        (name) => {
          names.add(name);

          return Effect.forEach(
            waiters.filter((waiter) => waiter.name === name),
            (waiter) => Deferred.succeed(waiter.seen, undefined),
          );
        },
      ),
    ),
    Effect.as(HttpServerResponse.empty()),
    // Test fixture: an export that is not OTLP JSON is a bug in the code under test.
    Effect.orDie,
  );

  const server = yield* Layer.build(
    HttpRouter.serve(HttpRouter.add("POST", "/v1/traces", receive)).pipe(
      Layer.provideMerge(BunHttpServer.layer({ port: 0 })),
    ),
  );

  return {
    url: yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(Effect.provide(server)),
    saw: (name: string) =>
      Effect.gen(function* () {
        if (names.has(name)) return;
        const seen = yield* Deferred.make<void>();
        waiters.push({ name, seen });
        yield* Deferred.await(seen);
      }),
  };
});

layer(BunFileSystem.layer)("via serve", (it) => {
  it.effect("serves /v1/responses through the added accounts, as configured in config.yaml", () =>
    withHome(({ home, key, env, codex }) =>
      Effect.gen(function* () {
        const port = yield* freePort;
        yield* (yield* FileSystem.FileSystem).writeFileString(
          `${home}/config.yaml`,
          `port: ${port}\ncodex:\n  cloak: false\n`,
        );
        const url = yield* serveVia(home, [], env);
        expect(url).toBe(`http://127.0.0.1:${port}`);

        const response = yield* postResponses(url, key);
        expect(response.status).toBe(200);
        expect(yield* response.json).toMatchObject({ id: "resp_fake", status: "completed" });
        expect(codex.requests[0]?.headers).toMatchObject({
          "chatgpt-account-id": "acc-123",
          originator: "via",
        });
      }),
    ),
  );

  it.effect("logs each request on one line, in logfmt", () =>
    withHome(({ home, key, env }) =>
      Effect.gen(function* () {
        const via = yield* startVia(home, ["--port", String(yield* freePort)], env);
        yield* postResponses(via.url, key);
        expect(yield* via.output("Sent HTTP response")).toMatch(
          /^timestamp=\S+ level=INFO fiber=#\d+ message="Sent HTTP response" http\.span=\d+ms request_id=[0-9a-f-]{36} http\.method=POST http\.url=\/v1\/responses http\.status=200 model=gpt-6-astra served_by=dev@example\.com input_tokens=10 output_tokens=2$/,
        );
      }),
    ),
  );

  it.effect("--host and --port override config.yaml", () =>
    withHome(({ home, env }) =>
      Effect.gen(function* () {
        const port = yield* freePort;
        yield* (yield* FileSystem.FileSystem).writeFileString(
          `${home}/config.yaml`,
          "host: 0.0.0.0\nport: 1\n",
        );
        const url = yield* serveVia(home, ["--host", "127.0.0.1", "--port", String(port)], env);
        expect(url).toBe(`http://127.0.0.1:${port}`);
      }),
    ),
  );

  it.effect("picks up accounts and keys changed by other via commands without a restart", () =>
    withHome(({ home, key, env }) =>
      Effect.gen(function* () {
        const url = yield* serveVia(home, ["--port", String(yield* freePort)], env);
        expect((yield* postResponses(url, key)).status).toBe(200);

        yield* runVia(home, ["accounts", "disable", "dev@example.com"]);
        expect((yield* postResponses(url, key)).status).toBe(503);
        yield* runVia(home, ["accounts", "enable", "dev@example.com"]);
        expect((yield* postResponses(url, key)).status).toBe(200);

        yield* runVia(home, ["keys", "revoke", "test"]);
        expect((yield* postResponses(url, key)).status).toBe(401);
      }),
    ),
  );

  it.effect("says so when its port is already in use", () =>
    Effect.gen(function* () {
      const taken = yield* Layer.build(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 }));

      const url = yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(
        Effect.provide(taken),
      );

      const port = new URL(url).port;
      const result = yield* runVia(yield* tempHome, ["serve", "--port", port]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(new RegExp(`^error: .*port ${port}.* in use`, "m"));
    }),
  );

  it.effect("serves the admin API behind VIA_ADMIN_KEY", () =>
    withHome(({ home, env }) =>
      Effect.gen(function* () {
        const adminKey = "admin-key-that-is-long-enough-000";

        const url = yield* serveVia(home, ["--port", String(yield* freePort)], {
          ...env,
          VIA_ADMIN_KEY: adminKey,
        });

        const response = yield* HttpClient.get(`${url}/admin/accounts`, {
          headers: { authorization: `Bearer ${adminKey}` },
        }).pipe(Effect.provide(FetchHttpClient.layer));

        expect(response.status).toBe(200);
        expect(yield* response.json).toMatchObject([{ email: "dev@example.com" }]);
      }),
    ),
  );

  it.effect("refuses to start with an admin key shorter than 32 characters", () =>
    Effect.gen(function* () {
      const port = String(yield* freePort);

      const result = yield* runVia(yield* tempHome, ["serve", "--port", port], {
        VIA_ADMIN_KEY: "short",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("VIA_ADMIN_KEY must be at least 32 characters; it has 5");
    }),
  );

  it.effect("refuses to start with an invalid config.yaml", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      yield* (yield* FileSystem.FileSystem).writeFileString(`${home}/config.yaml`, "port: nope\n");
      const result = yield* runVia(home, ["serve"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid config");
    }),
  );

  it.effect("keeps an account cooling down across a restart", () =>
    withHome(({ home, key, env, codex }) =>
      Effect.gen(function* () {
        codex.script(reply.error(429, "", { "retry-after": "3600" }));
        const port = String(yield* freePort);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const url = yield* serveVia(home, ["--port", port], env);
            expect((yield* postResponses(url, key)).status).toBe(429);
          }),
        );
        const url = yield* serveVia(home, ["--port", port], env);
        expect((yield* postResponses(url, key)).status).toBe(429);
        expect(codex.requests).toHaveLength(1);
      }),
    ),
  );

  it.effect("exports traces to the OTLP endpoint in the standard OpenTelemetry variables", () =>
    withHome(({ home, key, env }) =>
      Effect.gen(function* () {
        const collector = yield* startCollector;

        const url = yield* serveVia(home, ["--port", String(yield* freePort)], {
          ...env,
          OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
          OTEL_BSP_SCHEDULE_DELAY: "50",
        });

        expect((yield* postResponses(url, key)).status).toBe(200);
        yield* collector.saw("dispatch").pipe(Effect.timeout("10 seconds"), realTime);
      }),
    ),
  );

  it.effect("flushes spans it has not exported yet when it stops", () =>
    withHome(({ home, key, env }) =>
      Effect.gen(function* () {
        const collector = yield* startCollector;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const url = yield* serveVia(home, ["--port", String(yield* freePort)], {
              ...env,
              OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
              // Far beyond the test, so only the flush at shutdown can deliver the span.
              OTEL_BSP_SCHEDULE_DELAY: "600000",
            });

            expect((yield* postResponses(url, key)).status).toBe(200);
          }),
        );
        yield* collector.saw("dispatch").pipe(Effect.timeout("1 second"), realTime);
      }),
    ),
  );

  it.effect("sends upstreams no trace headers when no OTLP endpoint is set", () =>
    withHome(({ home, key, env, codex }) =>
      Effect.gen(function* () {
        const provider = yield* startFakeProvider;
        provider.respond(providerReply.json({ id: "chatcmpl-local" }));
        yield* (yield* FileSystem.FileSystem).writeFileString(
          `${home}/config.yaml`,
          `providers:\n  local:\n    baseUrl: ${provider.url}\n    apiKeyEnv: LOCAL_KEY\n`,
        );

        const url = yield* serveVia(home, ["--port", String(yield* freePort)], {
          ...env,
          LOCAL_KEY: "sk-local",
        });

        const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
        yield* HttpClientRequest.post(`${url}/v1/chat/completions`).pipe(
          HttpClientRequest.bearerToken(key),
          HttpClientRequest.bodyJsonUnsafe({ model: "local/qwen3", messages: [] }),
          http.execute,
        );
        expect((yield* postResponses(url, key)).status).toBe(200);

        for (const headers of [provider.requests[0]?.headers, codex.requests[0]?.headers]) {
          expect(headers).toBeDefined();
          expect(headers).not.toHaveProperty("traceparent");
          expect(headers).not.toHaveProperty("b3");
        }
      }),
    ),
  );

  it.effect(
    "forwards a provider's model with the API key from the variable config.yaml names",
    () =>
      withHome(({ home, key, env }) =>
        Effect.gen(function* () {
          const provider = yield* startFakeProvider;
          provider.respond(providerReply.json({ id: "chatcmpl-local" }));
          yield* (yield* FileSystem.FileSystem).writeFileString(
            `${home}/config.yaml`,
            `providers:\n  local:\n    baseUrl: ${provider.url}\n    apiKeyEnv: LOCAL_KEY\n`,
          );

          const url = yield* serveVia(home, ["--port", String(yield* freePort)], {
            ...env,
            LOCAL_KEY: "sk-local",
          });

          const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));

          const response = yield* HttpClientRequest.post(`${url}/v1/chat/completions`).pipe(
            HttpClientRequest.bearerToken(key),
            HttpClientRequest.bodyJsonUnsafe({ model: "local/qwen3", messages: [] }),
            http.execute,
          );

          expect(yield* response.json).toEqual({ id: "chatcmpl-local" });
          expect(provider.requests[0]?.headers["authorization"]).toBe("Bearer sk-local");
        }),
      ),
  );

  it.effect("cuts off a stream the upstream broke off without printing a stack trace", () =>
    withHome(({ home, key, env }) =>
      Effect.gen(function* () {
        const provider = yield* startFakeProvider;
        const received = yield* Deferred.make<void>();
        provider.respond(
          providerReply.sseThenDrop('data: {"id":"chatcmpl-local"}\n\n', Deferred.await(received)),
        );
        yield* (yield* FileSystem.FileSystem).writeFileString(
          `${home}/config.yaml`,
          `providers:\n  local:\n    baseUrl: ${provider.url}\n    apiKeyEnv: LOCAL_KEY\n`,
        );

        const via = yield* startVia(home, ["--port", String(yield* freePort)], {
          ...env,
          LOCAL_KEY: "sk-local",
        });

        const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));

        const response = yield* HttpClientRequest.post(`${via.url}/v1/chat/completions`).pipe(
          HttpClientRequest.bearerToken(key),
          HttpClientRequest.bodyJsonUnsafe({ model: "local/qwen3", messages: [], stream: true }),
          http.execute,
        );

        const read = yield* response.stream.pipe(
          Stream.tap(() => Deferred.succeed(received, undefined)),
          Stream.runDrain,
          Effect.exit,
        );

        // A clean end would pass the truncated answer off as complete.
        expect(Exit.isFailure(read)).toBe(true);
        expect(yield* via.stop).not.toContain("Decode error");
      }),
    ),
  );

  it.effect("refuses to start when a provider's API key variable is not set", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      yield* (yield* FileSystem.FileSystem).writeFileString(
        `${home}/config.yaml`,
        "providers:\n  openrouter:\n    apiKeyEnv: VIA_TEST_UNSET_KEY\n",
      );
      const result = yield* runVia(home, ["serve"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'error: Provider "openrouter" reads its API key from VIA_TEST_UNSET_KEY, which is not set',
      );
    }),
  );
});
