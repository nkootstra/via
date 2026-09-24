import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { fakeIssuer } from "@via/codex-auth/testing";
import { completedStream, fakeUpstream, type RecordedRequest } from "@via/codex-upstream/testing";
import { Effect, FileSystem, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServer } from "effect/unstable/http";
import { runVia, serveVia, tempHome } from "./helpers.ts";

/** A port nothing listens on right now. */
const freePort = Effect.sync(() => {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
});

/**
 * A `via` home with one account (from a fake issuer) and one API key, whose
 * upstream is a fake Codex backend that records what it receives.
 */
const withHome = <A, E, R>(
  body: (setup: {
    home: string;
    key: string;
    env: Record<string, string>;
    upstreamRequests: ReadonlyArray<RecordedRequest>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const home = yield* tempHome;
    const upstreamRequests: Array<RecordedRequest> = [];
    const upstream = yield* Layer.build(
      fakeUpstream((request) => {
        upstreamRequests.push(request);
        return { status: 200, body: completedStream("hello") };
      }),
    );
    const issuer = yield* Layer.build(fakeIssuer());
    const address = (context: typeof upstream | typeof issuer) =>
      HttpServer.addressFormattedWith(Effect.succeed).pipe(Effect.provide(context));
    const env = {
      VIA_CODEX_ISSUER: yield* address(issuer),
      VIA_CODEX_BASE_URL: yield* address(upstream),
    };
    yield* runVia(home, ["accounts", "add"], env);
    const created = yield* runVia(home, ["keys", "create", "--name", "test"]);
    const key = created.stdout.trim().split("\n").at(-1) ?? "";
    return yield* body({ home, key, env, upstreamRequests });
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

layer(BunFileSystem.layer)("via serve", (it) => {
  it.effect("serves /v1/responses through the added accounts, as configured in config.yaml", () =>
    withHome(({ home, key, env, upstreamRequests }) =>
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
        expect(yield* response.json).toMatchObject({ id: "resp_1", status: "completed" });
        expect(upstreamRequests[0]?.headers).toMatchObject({
          "chatgpt-account-id": "acc-123",
          originator: "via",
        });
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

  it.effect("refuses to start with an invalid config.yaml", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      yield* (yield* FileSystem.FileSystem).writeFileString(`${home}/config.yaml`, "port: nope\n");
      const result = yield* runVia(home, ["serve"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid config");
    }),
  );
});
