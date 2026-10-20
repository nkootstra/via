import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { type CodexRequest, reply } from "@via/codex-upstream/testing";
import { providerReply } from "@via/providers/testing";
import { Effect, Option } from "effect";
import { ok, outwait, type Via, withVia } from "./testing/harness.ts";

/** A prompt an upstream's error quotes back, which the usage history must never keep. */
const PROMPT = "REVIEW_PRIVATE_PROMPT_7a19";

const accountOf = (request: CodexRequest) => request.headers["chatgpt-account-id"];

/** Codex's answer to an account whose usage limit is reached. */
const usageLimit = reply.error(429, {
  error: {
    type: "usage_limit_reached",
    message: "The usage limit has been reached",
    resets_in_seconds: 3_600,
  },
});

/** The attempts of the latest request via kept, in order, once it has logged it. */
const attempts = (via: Via) =>
  Effect.gen(function* () {
    yield* via.logged("Sent HTTP response");

    const [request] = (yield* via.usage.requests({
      from: 0,
      to: Number.MAX_SAFE_INTEGER,
      limit: 1,
    })).requests;

    const conversation = Option.flatMap(Option.fromUndefinedOr(request), (r) => r.conversationId);

    if (request === undefined || Option.isNone(conversation)) return [];

    const found = yield* via.usage.conversation(conversation.value);

    return Option.match(found, {
      onNone: () => [],
      onSome: (whole) => whole.attempts.filter((a) => a.requestId === request.requestId),
    });
  });

layer(BunFileSystem.layer)("request attempts", (it) => {
  it.effect("keeps each Codex account tried, and why the one that couldn't serve didn't", () =>
    withVia(
      (request) => (accountOf(request) === "acc-a" ? usageLimit : ok()),
      (via) =>
        Effect.gen(function* () {
          yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });

          expect(yield* attempts(via)).toMatchObject([
            {
              seq: 0,
              provider: "codex",
              model: "gpt-6-astra",
              accountLabel: Option.some("a@example.com"),
              status: Option.some(429),
              outcome: "failed",
              category: Option.some("budget_exhausted"),
              upstreamCode: Option.some("usage_limit_reached"),
              downstreamProvider: Option.none(),
              message: Option.some("The usage limit has been reached"),
            },
            {
              seq: 1,
              provider: "codex",
              accountLabel: Option.some("b@example.com"),
              status: Option.some(200),
              outcome: "served",
              category: Option.none(),
              upstreamCode: Option.none(),
              message: Option.none(),
            },
          ]);
        }),
    ),
  );

  it.effect("keeps the fallback a request fell to after the model that couldn't serve", () =>
    withVia(
      () => reply.error(429, "", { "retry-after": "120" }),
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(
            providerReply.sse(
              'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
            ),
          );

          const response = yield* via.post("/v1/chat/completions", {
            model: "gpt-x",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          });

          yield* response.text;
          const kept = yield* attempts(via);

          expect(kept).toMatchObject([
            { seq: 0, model: "gpt-x", outcome: "failed", category: Option.some("rate_limited") },
            { seq: 1, model: "gpt-x", outcome: "failed", category: Option.some("rate_limited") },
            {
              seq: 2,
              provider: "openrouter",
              model: "openrouter/y",
              accountId: Option.none(),
              status: Option.some(200),
              outcome: "served",
              firstChunkMs: Option.some(expect.any(Number)),
            },
          ]);

          const [first, , served] = kept;
          expect(served?.startedAt).toBeGreaterThanOrEqual(first?.startedAt ?? Infinity);
        }),
      { fallbacks: [{ model: "gpt-x", fallbacks: ["openrouter/y"] }] },
    ),
  );

  it.effect("keeps which provider a router sent the request on to, and its words for it", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(
          providerReply.json(
            {
              error: {
                code: 502,
                message: "Provider returned error",
                metadata: { provider_name: "Together", raw: PROMPT },
              },
            },
            502,
          ),
        );

        yield* (yield* via.post("/v1/responses", { model: "openrouter/y", input: PROMPT })).text;

        expect(yield* attempts(via)).toMatchObject([
          {
            provider: "openrouter",
            status: Option.some(502),
            outcome: "failed",
            category: Option.some("downstream_unavailable"),
            upstreamCode: Option.some("502"),
            downstreamProvider: Option.some("Together"),
            message: Option.some("Provider returned error"),
          },
        ]);
      }),
    ),
  );

  it.effect("keeps no words of a refusal that could quote the request", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond((request) => ({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "invalid_input", message: request.body.input } }),
        }));

        yield* (yield* via.post("/v1/responses", { model: "openrouter/y", input: PROMPT })).text;
        const kept = yield* attempts(via);

        expect(kept).toMatchObject([
          {
            status: Option.some(400),
            outcome: "refused",
            category: Option.some("bad_request"),
            upstreamCode: Option.some("invalid_input"),
            message: Option.none(),
          },
        ]);

        expect(JSON.stringify(kept)).not.toContain(PROMPT);
      }),
    ),
  );

  it.effect("keeps an OpenCode Go account whose key is refused, and the one that served", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(
            providerReply.byKey({
              "sk-go-1": providerReply.json({ error: { message: "Invalid API key" } }, 401),
              "sk-go-2": providerReply.json({ id: "two" }),
            }),
          );

          yield* (yield* via.post("/v1/chat/completions", {
            model: "opencode-go/kimi-k3",
            messages: [],
          })).text;

          expect(yield* attempts(via)).toMatchObject([
            {
              provider: "opencode-go",
              accountLabel: Option.some("go-1"),
              status: Option.some(401),
              outcome: "failed",
              category: Option.some("auth"),
              message: Option.some("Invalid API key"),
            },
            { accountLabel: Option.some("go-2"), outcome: "served", firstChunkMs: Option.none() },
          ]);
        }),
      { opencodeGoKeys: ["sk-go-1", "sk-go-2"] },
    ),
  );

  it.effect("keeps an upstream that couldn't be reached, with no status", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });

          expect(yield* attempts(via)).toMatchObject([
            { status: Option.none(), outcome: "failed", category: Option.some("network") },
          ]);
        }),
      { codexUrl: "http://127.0.0.1:1" },
    ),
  );

  it.effect("keeps an upstream that went quiet for too long as a timeout", () =>
    withVia(
      () => reply.stalled(reply.text("hello"), 2),
      (via) =>
        Effect.gen(function* () {
          yield* Effect.forkChild(outwait(via, "5 minutes"));
          yield* via.post("/v1/chat/completions", {
            model: "gpt-6-astra",
            messages: [{ role: "user", content: "hi" }],
          });

          expect(yield* attempts(via)).toMatchObject([
            { status: Option.some(200), outcome: "failed", category: Option.some("timeout") },
          ]);
        }),
    ),
  );
});
