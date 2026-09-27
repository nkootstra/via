import { BunFileSystem, BunHttpServer } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { type FakeCodex, reply, startFakeCodex } from "@via/codex-upstream/testing";
import { type FakeProvider, providerReply, startFakeProvider } from "@via/providers/testing";
import { Deferred, Effect, Exit, Layer, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  createKey,
  freePort,
  realTime,
  runVia,
  serveVia,
  startVia,
  tempHome,
  viaHome,
  writeConfig,
} from "./helpers.ts";

/** The Responses requests `codex` received, leaving out the usage poll's lookups. */
const responsesOf = (codex: FakeCodex) =>
  codex.requests.filter(({ path }) => path === "/codex/responses");

/**
 * A `via` home with one account (from a fake issuer) and one API key, whose
 * upstream is a fake Codex backend that answers "hello" unless scripted otherwise.
 */
const loggedIn = Effect.gen(function* () {
  const codex = yield* startFakeCodex;
  codex.respond(() => reply.text("hello"));
  const { home, env, via } = yield* viaHome({ upstream: codex.url });
  yield* via("accounts", "add");

  return { home, env, codex, key: yield* createKey(home, "test") };
});

/** POSTs `body` to `path` on the via at `url`, with API key `key`. */
const post = (url: string, key: string, path: string, body: Schema.Json) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;

    return yield* HttpClientRequest.post(`${url}${path}`).pipe(
      HttpClientRequest.bearerToken(key),
      HttpClientRequest.bodyJsonUnsafe(body),
      http.execute,
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));

const postResponses = (url: string, key: string) =>
  post(url, key, "/v1/responses", { model: "gpt-6-astra", input: "hi" });

/** A chat completion for the `local` provider's `qwen3`. */
const postLocalChat = (url: string, key: string, stream = false) =>
  post(url, key, "/v1/chat/completions", { model: "local/qwen3", messages: [], stream });

/** Configures a provider `local`, served by `provider` and keyed by LOCAL_KEY. */
const configureLocal = (home: string, provider: FakeProvider) =>
  writeConfig(
    home,
    `providers:\n  local:\n    baseUrl: ${provider.url}\n    apiKeyEnv: LOCAL_KEY\n`,
  );

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
    Effect.gen(function* () {
      const { home, key, env, codex } = yield* loggedIn;
      const port = yield* freePort;
      yield* writeConfig(home, `port: ${port}\ncodex:\n  cloak: false\n`);
      const url = yield* serveVia(home, [], env);
      expect(url).toBe(`http://127.0.0.1:${port}`);

      const response = yield* postResponses(url, key);
      expect(response.status).toBe(200);
      expect(yield* response.json).toMatchObject({ id: "resp_fake", status: "completed" });
      expect(responsesOf(codex)[0]?.headers).toMatchObject({
        "chatgpt-account-id": "acc-123",
        originator: "via",
      });
    }),
  );

  it.effect("logs each request on one line, in logfmt", () =>
    Effect.gen(function* () {
      const { home, key, env } = yield* loggedIn;
      const via = yield* startVia(home, ["--port", "0"], env);
      yield* postResponses(via.url, key);
      expect(yield* via.output("Sent HTTP response")).toMatch(
        /^timestamp=\S+ level=INFO fiber=#\d+ message="Sent HTTP response" http\.span=\d+ms request_id=[0-9a-f-]{36} http\.method=POST http\.url=\/v1\/responses http\.status=200 model=gpt-6-astra served_by=dev@example\.com input_tokens=10 output_tokens=2$/,
      );
    }),
  );

  it.effect("--host and --port override config.yaml", () =>
    Effect.gen(function* () {
      const { home, env } = yield* loggedIn;
      const port = yield* freePort;
      yield* writeConfig(home, "host: 0.0.0.0\nport: 1\n");
      const url = yield* serveVia(home, ["--host", "127.0.0.1", "--port", String(port)], env);
      expect(url).toBe(`http://127.0.0.1:${port}`);
    }),
  );

  it.effect("picks up accounts and keys changed by other via commands without a restart", () =>
    Effect.gen(function* () {
      const { home, key, env } = yield* loggedIn;
      const url = yield* serveVia(home, ["--port", "0"], env);
      expect((yield* postResponses(url, key)).status).toBe(200);

      yield* runVia(home, ["accounts", "disable", "dev@example.com"]);
      expect((yield* postResponses(url, key)).status).toBe(503);
      yield* runVia(home, ["accounts", "enable", "dev@example.com"]);
      expect((yield* postResponses(url, key)).status).toBe(200);

      yield* runVia(home, ["keys", "revoke", "test"]);
      expect((yield* postResponses(url, key)).status).toBe(401);
    }),
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
    Effect.gen(function* () {
      const { home, env } = yield* loggedIn;
      const adminKey = "admin-key-that-is-long-enough-000";

      const url = yield* serveVia(home, ["--port", "0"], {
        ...env,
        VIA_ADMIN_KEY: adminKey,
      });

      const response = yield* HttpClient.get(`${url}/admin/accounts`, {
        headers: { authorization: `Bearer ${adminKey}` },
      }).pipe(Effect.provide(FetchHttpClient.layer));

      expect(response.status).toBe(200);
      expect(yield* response.json).toMatchObject([{ email: "dev@example.com" }]);
    }),
  );

  it.effect("serves the admin UI's build at /ui with VIA_ADMIN_KEY", () =>
    Effect.gen(function* () {
      const { home, env } = yield* loggedIn;

      const url = yield* serveVia(home, ["--port", "0"], {
        ...env,
        VIA_ADMIN_KEY: "admin-key-that-is-long-enough-000",
      });

      const response = yield* HttpClient.get(`${url}/ui/accounts`).pipe(
        Effect.provide(FetchHttpClient.layer),
      );

      expect(response.status).toBe(200);
      expect(response.headers["content-security-policy"]).toMatch(/script-src 'self' 'sha256-/);
      expect(yield* response.text).toMatch(/<script type="module" async="" src="\/ui\/assets\//);
    }),
  );

  it.effect("refuses to start with an admin key shorter than 32 characters", () =>
    Effect.gen(function* () {
      const result = yield* runVia(yield* tempHome, ["serve", "--port", "0"], {
        VIA_ADMIN_KEY: "short",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("VIA_ADMIN_KEY must be at least 32 characters; it has 5");
    }),
  );

  it.effect("refuses to start with an invalid config.yaml", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      yield* writeConfig(home, "port: nope\n");
      const result = yield* runVia(home, ["serve"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid config");
    }),
  );

  it.effect("keeps a stream open through a pause longer than Bun's 10s idle timeout", () =>
    Effect.gen(function* () {
      const { home, key, env, codex } = yield* loggedIn;
      // A few events, then silence, as while the model reasons.
      codex.script(reply.stalled(reply.text("hello"), 3));
      const url = yield* serveVia(home, ["--port", "0"], env);

      const response = yield* post(url, key, "/v1/chat/completions", {
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });

      const received = yield* response.stream.pipe(
        Stream.decodeText,
        Stream.interruptWhen(realTime(Effect.sleep("12 seconds"))),
        Stream.mkString,
      );

      expect(received).toContain(": keepalive");
    }),
  );

  it.effect("keeps an account cooling down across a restart", () =>
    Effect.gen(function* () {
      const { home, key, env, codex } = yield* loggedIn;
      codex.script(reply.error(429, "", { "retry-after": "3600" }));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const url = yield* serveVia(home, ["--port", "0"], env);
          expect((yield* postResponses(url, key)).status).toBe(429);
        }),
      );
      const url = yield* serveVia(home, ["--port", "0"], env);
      expect((yield* postResponses(url, key)).status).toBe(429);
      expect(responsesOf(codex)).toHaveLength(1);
    }),
  );

  for (const [variable, endpoint] of [
    ["OTEL_EXPORTER_OTLP_ENDPOINT", (collector: string) => collector],
    ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", (collector: string) => `${collector}/v1/traces`],
  ] as const) {
    it.effect(`exports traces to the OTLP endpoint ${variable} names`, () =>
      Effect.gen(function* () {
        const { home, key, env } = yield* loggedIn;
        const collector = yield* startCollector;

        const url = yield* serveVia(home, ["--port", "0"], {
          ...env,
          [variable]: endpoint(collector.url),
          OTEL_BSP_SCHEDULE_DELAY: "50",
        });

        expect((yield* postResponses(url, key)).status).toBe(200);
        yield* collector.saw("dispatch").pipe(Effect.timeout("10 seconds"), realTime);
      }),
    );
  }

  it.effect("flushes spans it has not exported yet when it stops", () =>
    Effect.gen(function* () {
      const { home, key, env } = yield* loggedIn;
      const collector = yield* startCollector;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const url = yield* serveVia(home, ["--port", "0"], {
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
  );

  it.effect("sends upstreams no trace headers when no OTLP endpoint is set", () =>
    Effect.gen(function* () {
      const { home, key, env, codex } = yield* loggedIn;
      const provider = yield* startFakeProvider;
      provider.respond(providerReply.json({ id: "chatcmpl-local" }));
      yield* configureLocal(home, provider);

      const url = yield* serveVia(home, ["--port", "0"], {
        ...env,
        LOCAL_KEY: "sk-local",
      });

      yield* postLocalChat(url, key);
      expect((yield* postResponses(url, key)).status).toBe(200);

      for (const headers of [provider.requests[0]?.headers, responsesOf(codex)[0]?.headers]) {
        expect(headers).toBeDefined();
        expect(headers).not.toHaveProperty("traceparent");
        expect(headers).not.toHaveProperty("b3");
      }
    }),
  );

  it.effect(
    "forwards a provider's model with the API key from the variable config.yaml names",
    () =>
      Effect.gen(function* () {
        const { home, key, env } = yield* loggedIn;
        const provider = yield* startFakeProvider;
        provider.respond(providerReply.json({ id: "chatcmpl-local" }));
        yield* configureLocal(home, provider);

        const url = yield* serveVia(home, ["--port", "0"], {
          ...env,
          LOCAL_KEY: "sk-local",
        });

        const response = yield* postLocalChat(url, key);
        expect(yield* response.json).toEqual({ id: "chatcmpl-local" });
        expect(provider.requests[0]?.headers["authorization"]).toBe("Bearer sk-local");
      }),
  );

  it.effect("cuts off a stream the upstream broke off without printing a stack trace", () =>
    Effect.gen(function* () {
      const { home, key, env } = yield* loggedIn;
      const provider = yield* startFakeProvider;
      const received = yield* Deferred.make<void>();
      provider.respond(
        providerReply.sseThenDrop('data: {"id":"chatcmpl-local"}\n\n', Deferred.await(received)),
      );
      yield* configureLocal(home, provider);

      const via = yield* startVia(home, ["--port", "0"], {
        ...env,
        LOCAL_KEY: "sk-local",
      });

      const response = yield* postLocalChat(via.url, key, true);

      const read = yield* response.stream.pipe(
        Stream.tap(() => Deferred.succeed(received, undefined)),
        Stream.runDrain,
        Effect.exit,
      );

      // A clean end would pass the truncated answer off as complete.
      expect(Exit.isFailure(read)).toBe(true);
      expect(yield* via.stop).not.toContain("Decode error");
    }),
  );

  it.effect("refuses to start when a provider's API key variable is not set", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      yield* writeConfig(home, "providers:\n  openrouter:\n    apiKeyEnv: VIA_TEST_UNSET_KEY\n");
      const result = yield* runVia(home, ["serve"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'error: Provider "openrouter" reads its API key from VIA_TEST_UNSET_KEY, which is not set',
      );
    }),
  );
});
