import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply, sse } from "@via/codex-upstream/testing";
import { type ProviderReply, providerReply } from "@via/providers/testing";
import { Effect, FileSystem, Option, Predicate } from "effect";
import { ok, type Via, withVia } from "../testing/harness.ts";

/** Every Codex account answers that its usage limit is reached. */
const exhausted = () => reply.error(429, "", { "retry-after": "120" });

const answer = { id: "chatcmpl-1", object: "chat.completion", choices: [] };

/** A provider that is down, asking to be tried again in `retryAfter` seconds. */
const down = (retryAfter = "30") =>
  providerReply.json({ error: { message: "down", code: "server_down" } }, 503, {
    "retry-after": retryAfter,
  });

/** Answers each request as `replies` says for the model it asks for, else as a provider that is down. */
const byModel =
  (replies: Readonly<Record<string, ProviderReply>>): ProviderReply =>
  (request) => {
    const model = request.body["model"];
    const scripted = Predicate.isString(model) ? replies[model] : undefined;

    return (scripted ?? down())(request);
  };

/** The event Codex starts a response with. */
const created = {
  type: "response.created",
  response: { id: "resp_1", created_at: 1_700_000_000, model: "gpt-x", status: "in_progress" },
};

const chat = (model: string) => ({ model, messages: [{ role: "user", content: "hi" }] });

const modelsAsked = (via: Via) => via.provider.requests.map((request) => request.body["model"]);

layer(BunFileSystem.layer)("fallback models", (it) => {
  it.effect("answers with the fallback when every account for the model is cooling down", () =>
    withVia(
      exhausted,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(providerReply.json(answer));

          const response = yield* via.post("/v1/responses", { model: "gpt-x", input: "hi" });

          expect(response.status).toBe(200);
          expect(response.headers["x-via-fallback"]).toBe("gpt-x -> openrouter/y");
          expect(yield* response.json).toEqual(answer);
          expect(via.provider.requests.map((request) => request.body["model"])).toEqual(["y"]);
        }),
      { fallbacks: [{ model: "gpt-x", fallbacks: ["openrouter/y"] }] },
    ),
  );

  it.effect("answers a provider's model with a Codex fallback over chat, translated", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(down());

          const response = yield* via.post("/v1/chat/completions", chat("openrouter/y"));

          expect(response.status).toBe(200);
          expect(response.headers["x-via-fallback"]).toBe("openrouter/y -> gpt-6-astra");
          expect(via.upstreamRequests.map((request) => request.body["model"])).toEqual([
            "gpt-6-astra",
          ]);
        }),
      { fallbacks: [{ model: "openrouter/y", fallbacks: ["gpt-6-astra"] }] },
    ),
  );

  it.effect("falls back when Codex is down", () =>
    withVia(
      () => reply.error(503, { error: { code: "server_is_overloaded", message: "busy" } }),
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(providerReply.json(answer));

          const response = yield* via.post("/v1/chat/completions", chat("gpt-x"));

          expect(response.headers["x-via-fallback"]).toBe("gpt-x -> openrouter/y");
        }),
      { fallbacks: [{ model: "gpt-x", fallbacks: ["openrouter/y"] }] },
    ),
  );

  it.effect("falls back when Codex fails a response it was collecting for being overloaded", () =>
    withVia(
      () => reply.failed("server_is_overloaded", "Codex is busy"),
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(providerReply.json(answer));

          const response = yield* via.post("/v1/chat/completions", chat("gpt-x"));

          expect(response.status).toBe(200);
          expect(response.headers["x-via-fallback"]).toBe("gpt-x -> openrouter/y");
        }),
      { fallbacks: [{ model: "gpt-x", fallbacks: ["openrouter/y"] }] },
    ),
  );

  // Nothing has gone out to a client that doesn't stream while via collects Codex's answer.
  for (const [broke, broken] of [
    ["the connection breaks off", () => reply.hangUp(reply.text("hello"), 2)],
    ["the stream ends early", () => reply.sse(sse([created]))],
    [
      "the stream holds an event via can't read",
      () => reply.sse(`${sse([created])}data: {not json\n\n`),
    ],
    ["Codex asks to be retried", () => reply.sse(`${sse([created])}retry: 1000\n\n`)],
  ] as const) {
    for (const [path, body] of [
      ["/v1/chat/completions", chat("gpt-x")],
      ["/v1/responses", { model: "gpt-x", input: "hi" }],
    ] as const) {
      it.effect(`falls back on ${path} when ${broke} before the answer went out`, () =>
        withVia(
          broken,
          (via) =>
            Effect.gen(function* () {
              via.provider.respond(providerReply.json(answer));

              const response = yield* via.post(path, body);

              expect(response.status).toBe(200);
              expect(response.headers["x-via-fallback"]).toBe("gpt-x -> openrouter/y");
              expect(modelsAsked(via)).toEqual(["y"]);

              const { annotations } = yield* via.logged("Sent HTTP response");
              expect(annotations).toMatchObject({ fallback_reason: "upstream_incomplete" });
            }),
          { fallbacks: [{ model: "gpt-x", fallbacks: ["openrouter/y"] }] },
        ),
      );
    }
  }

  it.effect("doesn't fall back when Codex's final response can't be read", () =>
    withVia(
      () => reply.sse(sse([created, { type: "response.completed", response: {} }])),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/chat/completions", chat("gpt-x"));

          expect(response.status).toBe(502);
          expect(response.headers).not.toHaveProperty("x-via-fallback");
          expect(via.provider.requests).toEqual([]);
        }),
      { fallbacks: [{ model: "gpt-x", fallbacks: ["openrouter/y"] }] },
    ),
  );

  it.effect("doesn't fall back once a streamed answer has started and its connection breaks", () =>
    withVia(
      () => reply.hangUp(reply.sse(sse([created])), 2),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", {
            model: "gpt-x",
            input: "hi",
            stream: true,
          });

          yield* response.text.pipe(Effect.ignore);
          expect(response.headers).not.toHaveProperty("x-via-fallback");
          expect(via.provider.requests).toEqual([]);
        }),
      { fallbacks: [{ model: "gpt-x", fallbacks: ["openrouter/y"] }] },
    ),
  );

  it.effect("falls back when the provider can't be reached", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/chat/completions", chat("openrouter/y"));

          expect(response.status).toBe(200);
          expect(response.headers["x-via-fallback"]).toBe("openrouter/y -> gpt-6-astra");
        }),
      {
        providerUrl: "http://127.0.0.1:1",
        fallbacks: [{ model: "openrouter/y", fallbacks: ["gpt-6-astra"] }],
      },
    ),
  );

  it.effect("falls back when the provider rate limits the request", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(providerReply.rateLimited({ "retry-after": "5" }));

          const response = yield* via.post("/v1/chat/completions", chat("openrouter/y"));

          expect(response.headers["x-via-fallback"]).toBe("openrouter/y -> gpt-6-astra");
        }),
      { fallbacks: [{ model: "openrouter/y", fallbacks: ["gpt-6-astra"] }] },
    ),
  );

  it.effect("falls back when an OpenCode Go model can't be asked in the Responses API", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(
            providerReply.json(
              { error: { code: "ModelProtocolUnsupported", message: "chat only" } },
              400,
            ),
          );

          const response = yield* via.post("/v1/responses", {
            model: "opencode-go/m",
            input: "hi",
          });

          expect(response.status).toBe(200);
          expect(response.headers["x-via-fallback"]).toBe("opencode-go/m -> gpt-6-astra");
        }),
      { fallbacks: [{ model: "opencode-go/m", fallbacks: ["gpt-6-astra"] }] },
    ),
  );

  it.effect("falls back when OpenCode Go has no account", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/chat/completions", chat("opencode-go/m"));

          expect(response.headers["x-via-fallback"]).toBe("opencode-go/m -> gpt-6-astra");
        }),
      { opencodeGoKeys: [], fallbacks: [{ model: "opencode-go/m", fallbacks: ["gpt-6-astra"] }] },
    ),
  );

  it.effect("passes on a refusal of the request itself, without falling back", () =>
    withVia(
      () => reply.error(400, { error: { code: "invalid_value", message: "Bad effort" } }),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/chat/completions", chat("gpt-x"));

          expect(response.status).toBe(400);
          expect(response.headers).not.toHaveProperty("x-via-fallback");
          expect(via.provider.requests).toEqual([]);
        }),
      { fallbacks: [{ model: "gpt-x", fallbacks: ["openrouter/y"] }] },
    ),
  );

  it.effect("doesn't fall back once an answer has started", () =>
    withVia(
      () => reply.failed("server_error", "The model broke down"),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", {
            model: "gpt-x",
            input: "hi",
            stream: true,
          });

          expect(yield* response.text).toContain("response.failed");
          expect(response.headers).not.toHaveProperty("x-via-fallback");
          expect(via.provider.requests).toEqual([]);
        }),
      { fallbacks: [{ model: "gpt-x", fallbacks: ["openrouter/y"] }] },
    ),
  );

  it.effect("moves past a fallback via doesn't know, without asking for it", () =>
    withVia(
      exhausted,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(providerReply.json(answer));

          const response = yield* via.post("/v1/chat/completions", chat("gpt-x"));

          expect(response.headers["x-via-fallback"]).toBe("gpt-x -> openrouter/y");
          expect(via.upstreamRequests.map((request) => request.body["model"])).not.toContain(
            "gpt-nope",
          );
          expect(yield* via.logged("gpt-nope can't serve (not_listed)")).toBeDefined();
        }),
      { fallbacks: [{ model: "gpt-x", fallbacks: ["gpt-nope", "openrouter/y"] }] },
    ),
  );

  it.effect("moves past a fallback its provider doesn't have", () =>
    withVia(
      exhausted,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(
            byModel({
              missing: providerReply.json({ error: { code: "model_not_found" } }, 404),
              z: providerReply.json(answer),
            }),
          );

          const response = yield* via.post("/v1/chat/completions", chat("gpt-x"));

          expect(response.headers["x-via-fallback"]).toBe("gpt-x -> opencode-go/z");
          expect(modelsAsked(via)).toEqual(["missing", "z"]);
        }),
      { fallbacks: [{ model: "gpt-x", fallbacks: ["openrouter/missing", "opencode-go/z"] }] },
    ),
  );

  it.effect("tries each fallback in turn, and logs only the one that served", () =>
    withVia(
      exhausted,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(byModel({ z: providerReply.json(answer) }));

          const response = yield* via.post("/v1/chat/completions", chat("gpt-x"));

          expect(response.headers["x-via-fallback"]).toBe("gpt-x -> opencode-go/z");
          expect(modelsAsked(via)).toEqual(["y", "z"]);

          const { annotations } = yield* via.logged("Sent HTTP response");
          expect(annotations).toMatchObject({
            "http.status": 200,
            model: "opencode-go/z",
            served_by: "go-1",
            requested_model: "gpt-x",
            fallback_reason: "rate_limit_exceeded",
          });
          expect(annotations).not.toHaveProperty("error");
          expect(annotations).not.toHaveProperty("upstream_error");
          expect(yield* via.logged("so openrouter/y is asked instead")).toBeDefined();
          expect(yield* via.logged("openrouter/y can't serve (server_down)")).toBeDefined();
        }),
      { fallbacks: [{ model: "gpt-x", fallbacks: ["openrouter/y", "opencode-go/z"] }] },
    ),
  );

  it.effect(
    "answers as the model asked for when no fallback can serve, retrying when the first may",
    () =>
      withVia(
        exhausted,
        (via) =>
          Effect.gen(function* () {
            via.provider.respond(down("7"));

            const response = yield* via.post("/v1/chat/completions", chat("gpt-x"));

            expect(response.status).toBe(429);
            expect(response.headers["retry-after"]).toBe("7");
            expect(response.headers).not.toHaveProperty("x-via-fallback");

            const { annotations } = yield* via.logged("Sent HTTP response");
            expect(annotations).toMatchObject({ model: "gpt-x", error: "rate_limit_exceeded" });
            expect(annotations).not.toHaveProperty("requested_model");

            const { requests } = yield* via.usage.requests({
              from: 0,
              to: Date.now() * 2,
              limit: 5,
            });

            expect(requests.map((entry) => [entry.model, entry.requestedModel])).toEqual([
              ["gpt-x", Option.none()],
            ]);
          }),
        { fallbacks: [{ model: "gpt-x", fallbacks: ["openrouter/y"] }] },
      ),
  );

  it.effect("keeps the model asked for and why it fell back in the usage history", () =>
    withVia(
      exhausted,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(providerReply.json(answer));

          yield* via.post("/v1/chat/completions", chat("gpt-x"));
          yield* via.logged("Sent HTTP response");

          const { requests } = yield* via.usage.requests({ from: 0, to: Date.now() * 2, limit: 5 });
          expect(
            requests.map((entry) => [entry.model, entry.requestedModel, entry.fallbackReason]),
          ).toEqual([["openrouter/y", Option.some("gpt-x"), Option.some("rate_limit_exceeded")]]);
        }),
      { fallbacks: [{ model: "gpt-x", fallbacks: ["openrouter/y"] }] },
    ),
  );

  it.effect("covers a model asked for with an effort", () =>
    withVia(
      exhausted,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(providerReply.json(answer));

          const response = yield* via.post("/v1/chat/completions", chat("gpt-6-astra-high"));

          expect(response.headers["x-via-fallback"]).toBe("gpt-6-astra-high -> openrouter/y");
        }),
      { fallbacks: [{ model: "gpt-6-astra", fallbacks: ["openrouter/y"] }] },
    ),
  );

  it.effect("doesn't follow a fallback's own rule", () =>
    withVia(
      exhausted,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(byModel({ z: providerReply.json(answer) }));

          const response = yield* via.post("/v1/chat/completions", chat("gpt-x"));

          expect(response.status).toBe(429);
          expect(modelsAsked(via)).toEqual(["y"]);
        }),
      {
        fallbacks: [
          { model: "gpt-x", fallbacks: ["openrouter/y"] },
          { model: "openrouter/y", fallbacks: ["opencode-go/z"] },
        ],
      },
    ),
  );

  it.effect("answers as the model asked for when the rules can't be read", () =>
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      withVia(exhausted, (via) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(`${via.dir}/fallbacks.json`, "{");

          const response = yield* via.post("/v1/chat/completions", chat("gpt-x"));

          expect(response.status).toBe(429);
          expect(yield* via.logged("Could not read the fallback rules")).toBeDefined();
        }),
      ),
    ),
  );

  it.effect("applies a rule set while via runs, as `via fallbacks set` does", () =>
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      withVia(exhausted, (via) =>
        Effect.gen(function* () {
          via.provider.respond(providerReply.json(answer));
          yield* fs.writeFileString(
            `${via.dir}/fallbacks.json`,
            JSON.stringify([{ model: "gpt-x", fallbacks: ["openrouter/y"] }]),
          );

          const response = yield* via.post("/v1/chat/completions", chat("gpt-x"));

          expect(response.headers["x-via-fallback"]).toBe("gpt-x -> openrouter/y");
        }),
      ),
    ),
  );

  it.effect("never falls back from System One, whose answers belong to its model", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(down());

          const response = yield* via.post("/v1/systemone", {
            model: "ollama/nimble",
            state: "x",
          });

          expect(response.status).toBe(503);
          expect(via.upstreamRequests).toEqual([]);
        }),
      { ollama: true, fallbacks: [{ model: "ollama/nimble", fallbacks: ["gpt-6-astra"] }] },
    ),
  );
});
