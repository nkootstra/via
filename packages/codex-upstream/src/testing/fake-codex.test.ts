import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Option, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { reply, startFakeCodex } from "./fake-codex.ts";
import { codexFixture } from "./fixtures.ts";

const post = (url: string, account: string, body: object = { model: "gpt-6-astra" }) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.post(`${url}/codex/responses`).pipe(
      HttpClientRequest.setHeaders({ authorization: "Bearer at", "chatgpt-account-id": account }),
      HttpClientRequest.bodyJsonUnsafe(body),
      http.execute,
    );
    return { status: response.status, headers: response.headers, text: yield* response.text };
  }).pipe(Effect.provide(FetchHttpClient.layer));

const events = (text: string) => [...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);

layer(BunFileSystem.layer)("the fake Codex backend", (it) => {
  it.effect("answers a scripted text reply with the full Responses event sequence", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.script(reply.text("pong"));
      const answer = yield* post(codex.url, "acc-a");
      expect(answer.status).toBe(200);
      expect(answer.headers["content-type"]).toContain("text/event-stream");
      expect(events(answer.text)).toEqual([
        "response.created",
        "response.in_progress",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.output_text.done",
        "response.content_part.done",
        "response.output_item.done",
        "response.completed",
      ]);
      expect(answer.text).toContain('"text":"pong"');
    }),
  );

  it.effect("records every request raw, authorization included", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.script(reply.text("pong"));
      yield* post(codex.url, "acc-a", { model: "gpt-6-astra", store: false });
      expect(codex.requests).toEqual([
        expect.objectContaining({
          path: "/codex/responses",
          headers: expect.objectContaining({
            authorization: "Bearer at",
            "chatgpt-account-id": "acc-a",
          }),
          body: { model: "gpt-6-astra", store: false },
        }),
      ]);
    }),
  );

  it.effect("serves account-specific replies before the shared script", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.forAccount("acc-a", reply.error(429, { error: { type: "usage_limit_reached" } }));
      codex.script(reply.text("shared"));
      expect((yield* post(codex.url, "acc-a")).status).toBe(429);
      expect((yield* post(codex.url, "acc-a")).text).toContain("shared");
    }),
  );

  it.effect("fails loudly on a request nobody scripted", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      const answer = yield* post(codex.url, "acc-a");
      expect(answer.status).toBe(599);
      expect(answer.text).toContain("unscripted");
    }),
  );

  it.effect("answers from a handler when the queues are empty", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.respond((request) => reply.text(`echo ${String(request.body["model"])}`));
      expect((yield* post(codex.url, "acc-a")).text).toContain("echo gpt-6-astra");
    }),
  );

  it.effect("replays a verbatim Codex fixture", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.script(reply.sse(yield* codexFixture("response-failed-rate-limit.sse")));
      const answer = yield* post(codex.url, "acc-a");
      expect(events(answer.text)).toEqual(["response.failed"]);
      expect(answer.text).toContain("rate_limit_exceeded");
    }),
  );

  it.effect("fails a response in-stream after it started", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.script(reply.failed("server_is_overloaded", "busy"));
      const answer = yield* post(codex.url, "acc-a");
      expect(answer.status).toBe(200);
      expect(events(answer.text)).toEqual([
        "response.created",
        "response.in_progress",
        "response.failed",
      ]);
      expect(answer.text).toContain('"error":{"code":"server_is_overloaded","message":"busy"}');
    }),
  );

  it.effect("truncates a stream after n events, ending it cleanly", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.script(reply.truncated(reply.text("pong"), 2));
      const answer = yield* post(codex.url, "acc-a");
      expect(events(answer.text)).toEqual(["response.created", "response.in_progress"]);
    }),
  );

  it.effect("hangs up mid-stream, resetting the connection", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.script(reply.hangUp(reply.text("pong"), 2));
      const outcome = yield* post(codex.url, "acc-a").pipe(Effect.exit);
      expect(Exit.isFailure(outcome)).toBe(true);
    }),
  );

  it.effect("stalls a stream after n events, keeping the connection open", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.script(reply.stalled(reply.text("pong"), 1));
      const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      const response = yield* HttpClientRequest.post(`${codex.url}/codex/responses`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ model: "gpt-6-astra" }),
        http.execute,
      );
      const first = yield* response.stream.pipe(Stream.decodeText, Stream.runHead);
      expect(Option.getOrThrow(first)).toContain("response.created");
    }),
  );

  it.effect("holds a reply until the test releases it", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      const gate = yield* Deferred.make<void>();
      codex.script(reply.held(gate, reply.text("late")));
      const pending = yield* post(codex.url, "acc-a").pipe(Effect.forkChild);
      yield* codex.received(1);
      expect(pending.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(gate, undefined);
      expect((yield* Fiber.join(pending)).text).toContain("late");
    }),
  );

  it.effect("serves /wham/usage per account", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.usage("acc-a", yield* codexFixture("usage.json"));
      const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      const answer = yield* http
        .execute(
          HttpClientRequest.get(`${codex.url}/wham/usage`).pipe(
            HttpClientRequest.setHeader("chatgpt-account-id", "acc-a"),
          ),
        )
        .pipe(Effect.flatMap((response) => response.json));
      expect(answer).toMatchObject({ rate_limit: expect.any(Object) });
    }),
  );

  it.effect("serves a scripted /codex/models catalog", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.models({ models: [{ slug: "gpt-6-astra" }] });
      const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      const answer = yield* http
        .execute(HttpClientRequest.get(`${codex.url}/codex/models?client_version=1.0.0`))
        .pipe(Effect.flatMap((response) => response.json));
      expect(answer).toEqual({ models: [{ slug: "gpt-6-astra" }] });
      expect(codex.requests.at(-1)?.path).toBe("/codex/models");
    }),
  );

  it.effect("fails an unscripted /codex/models request loudly", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      const response = yield* http.execute(HttpClientRequest.get(`${codex.url}/codex/models`));
      expect(response.status).toBe(599);
    }),
  );
});
