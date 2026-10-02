import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { type CodexRequest, reply } from "@via/codex-upstream/testing";
import { Effect, Option, Schema } from "effect";
import {
  chat,
  type Codex,
  errorFixture,
  json,
  launchVia,
  openai,
  post,
  responsesOf,
  runVia,
  startCodex,
} from "./harness.ts";

// The pool suite drives a real `via serve` against the fake Codex backend,
// scripting each account's answers through its `chatgpt-account-id`.

/** The ChatGPT account of every Responses request, in order. */
const accountsOf = (codex: Codex) =>
  responsesOf(codex).map((request) => request.headers["chatgpt-account-id"]);

const accountOf = (request: CodexRequest) => request.headers["chatgpt-account-id"];

const answerOf = (prompt: string) => `answer-for-${prompt}`;

/** The single user-message text of a Responses-shaped request body, or "". */
const PromptBody = Schema.Struct({
  input: Schema.Array(
    Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }),
  ),
});

const decodePromptBody = Schema.decodeUnknownOption(PromptBody);

const promptOf = (request: CodexRequest): string =>
  decodePromptBody(request.body).pipe(
    Option.map((decoded) => decoded.input[0]?.content[0]?.text ?? ""),
    Option.getOrElse(() => ""),
  );

layer(BunFileSystem.layer)("pool", (it) => {
  const pair = [{ name: "a" }, { name: "b" }];

  it.effect("fill-first: all traffic goes to the oldest account until it fails", () =>
    Effect.gen(function* () {
      const codex = yield* startCodex;
      codex.respond(() => reply.text("pong"));
      const via = yield* launchVia({ upstream: codex.url, accounts: pair });

      for (let i = 0; i < 3; i++) {
        const completion = yield* chat(via, `ping-${i}`);
        expect(completion.choices[0]?.message.content).toBe("pong");
      }

      expect(accountsOf(codex)).toEqual(["acc-a", "acc-a", "acc-a"]);
    }),
  );

  it.effect("a 429 with Retry-After fails over to the next account and cools the first down", () =>
    Effect.gen(function* () {
      const codex = yield* startCodex;
      codex.forAccount(
        "acc-a",
        reply.error(429, { error: { type: "rate_limit_exceeded" } }, { "retry-after": "60" }),
      );
      codex.respond(() => reply.text("pong"));
      const via = yield* launchVia({ upstream: codex.url, accounts: pair });
      // The client sees one successful call; via retried transparently underneath.
      const first = yield* chat(via, "first");
      expect(first.choices[0]?.message.content).toBe("pong");
      expect(accountsOf(codex)).toEqual(["acc-a", "acc-b"]);

      // A follow-up request skips the now-cooling account entirely.
      const second = yield* chat(via, "second");
      expect(second.choices[0]?.message.content).toBe("pong");
      expect(accountsOf(codex)).toEqual(["acc-a", "acc-b", "acc-b"]);
    }),
  );

  it.effect(
    "a quota error body (usage_limit_reached / resets_at) fails over to the next account",
    () =>
      Effect.gen(function* () {
        const resetsAt = Math.floor(Date.now() / 1000) + 3600; // far beyond this test's runtime
        const codex = yield* startCodex;
        // A non-429 status: the quota *code*, not the status, must drive the failover.
        codex.forAccount(
          "acc-a",
          reply.error(403, { error: { code: "usage_limit_reached", resets_at: resetsAt } }),
        );
        codex.respond(() => reply.text("pong"));
        const via = yield* launchVia({ upstream: codex.url, accounts: pair });
        const completion = yield* chat(via, "quota");
        expect(completion.choices[0]?.message.content).toBe("pong");
        expect(accountsOf(codex)).toEqual(["acc-a", "acc-b"]);

        // Still cooling: a second request goes straight to b.
        yield* chat(via, "quota-2");
        expect(accountsOf(codex)).toEqual(["acc-a", "acc-b", "acc-b"]);
      }),
  );

  it.effect("a quota code codex knows fails over even on a 400", () =>
    Effect.gen(function* () {
      const codex = yield* startCodex;
      codex.forAccount("acc-a", reply.error(400, { error: { code: "credit_balance_exhausted" } }));
      codex.respond(() => reply.text("pong"));
      const via = yield* launchVia({ upstream: codex.url, accounts: pair });
      const completion = yield* chat(via, "credits");
      expect(completion.choices[0]?.message.content).toBe("pong");
      expect(accountsOf(codex)).toEqual(["acc-a", "acc-b"]);
    }),
  );

  // An outage hits every account alike: via neither fails over nor cools the account down.
  it.effect("codex's 500 fixture answers 502 and leaves the account in rotation", () =>
    Effect.gen(function* () {
      const codex = yield* startCodex;
      codex.forAccount("acc-a", yield* errorFixture("internal_server_error_500"));
      const via = yield* launchVia({ upstream: codex.url, accounts: pair });

      const response = yield* post(via, "/v1/chat/completions", {
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "boom" }],
      });

      expect(response.status).toBe(502);
      expect(yield* json(response)).toMatchObject({
        error: { type: "server_error", code: "server_error" },
      });

      codex.forAccount("acc-a", reply.text("pong"));
      const completion = yield* chat(via, "again");
      expect(completion.choices[0]?.message.content).toBe("pong");
      expect(accountsOf(codex)).toEqual(["acc-a", "acc-a"]);
    }),
  );

  it.effect("codex's overloaded 503 fixture answers 503 with its Retry-After", () =>
    Effect.gen(function* () {
      const codex = yield* startCodex;
      codex.forAccount("acc-a", yield* errorFixture("server_overloaded_503"));
      const via = yield* launchVia({ upstream: codex.url, accounts: pair });

      const response = yield* post(via, "/v1/chat/completions", {
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "overloaded" }],
      });

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(yield* json(response)).toMatchObject({
        error: { type: "server_error", code: "server_is_overloaded" },
      });
      expect(accountsOf(codex)).toEqual(["acc-a"]);
    }),
  );

  it.effect(
    "every account cooling down returns 429 with a Retry-After header and an OpenAI error",
    () =>
      Effect.gen(function* () {
        const codex = yield* startCodex;
        codex.respond((request) =>
          reply.error(
            429,
            { error: { type: "rate_limit_exceeded" } },
            { "retry-after": accountOf(request) === "acc-a" ? "30" : "45" },
          ),
        );
        const via = yield* launchVia({ upstream: codex.url, accounts: pair });

        const response = yield* post(via, "/v1/chat/completions", {
          model: "gpt-6-astra",
          messages: [{ role: "user", content: "hi" }],
        });

        expect(response.status).toBe(429);
        const retryAfter = Number(response.headers.get("retry-after"));
        expect(retryAfter).toBeGreaterThan(0);
        expect(retryAfter).toBeLessThanOrEqual(45);
        expect(yield* json(response)).toMatchObject({
          error: { code: "rate_limit_exceeded", message: expect.any(String) },
        });
        // Every account was tried exactly once before via gave up.
        expect(accountsOf(codex)).toEqual(["acc-a", "acc-b"]);
      }),
  );

  it.effect("no accounts in the pool returns 503 no_accounts", () =>
    Effect.gen(function* () {
      const codex = yield* startCodex;
      const via = yield* launchVia({ upstream: codex.url, accounts: [] });

      const response = yield* post(via, "/v1/chat/completions", {
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(response.status).toBe(503);
      expect(yield* json(response)).toMatchObject({
        error: { code: "no_accounts", message: expect.any(String) },
      });
      expect(responsesOf(codex)).toHaveLength(0);
    }),
  );

  it.effect("a seeded disabled account is skipped from the start", () =>
    Effect.gen(function* () {
      const codex = yield* startCodex;
      codex.respond(() => reply.text("pong"));

      const via = yield* launchVia({
        upstream: codex.url,
        accounts: [{ name: "a", enabled: false }, { name: "b" }],
      });

      const completion = yield* chat(via, "hi");
      expect(completion.choices[0]?.message.content).toBe("pong");
      expect(accountsOf(codex)).toEqual(["acc-b"]);
    }),
  );

  it.effect("disabling and re-enabling an account changes routing on the next request, live", () =>
    Effect.gen(function* () {
      const codex = yield* startCodex;
      codex.respond(() => reply.text("pong"));
      const via = yield* launchVia({ upstream: codex.url, accounts: pair });
      yield* chat(via, "before");
      expect(accountsOf(codex)).toEqual(["acc-a"]);

      const disabled = yield* runVia(via.home, ["accounts", "disable", "a"], via.env);
      expect(disabled.exitCode).toBe(0);
      yield* chat(via, "while-disabled");
      expect(accountsOf(codex)).toEqual(["acc-a", "acc-b"]);

      const enabled = yield* runVia(via.home, ["accounts", "enable", "a"], via.env);
      expect(enabled.exitCode).toBe(0);
      yield* chat(via, "after");
      expect(accountsOf(codex)).toEqual(["acc-a", "acc-b", "acc-a"]);
    }),
  );

  it.effect("20 concurrent chat requests all succeed, each with its own answer", () =>
    Effect.gen(function* () {
      const prompts = Array.from({ length: 20 }, (_, i) => `concurrent-prompt-${i}`);
      const codex = yield* startCodex;
      codex.respond((request) => reply.text(answerOf(promptOf(request))));
      const via = yield* launchVia({ upstream: codex.url, accounts: [{ name: "a" }] });

      const completions = yield* Effect.forEach(prompts, (prompt) => chat(via, prompt), {
        concurrency: "unbounded",
      });

      for (const [i, prompt] of prompts.entries()) {
        expect(completions[i]?.choices[0]?.message.content).toBe(answerOf(prompt));
      }

      expect(accountsOf(codex)).toEqual(prompts.map(() => "acc-a"));
    }),
  );

  it.effect("a non-retryable 400 from upstream passes through unchanged", () =>
    Effect.gen(function* () {
      const errorBody = {
        error: {
          message: "bad input",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      };

      const codex = yield* startCodex;
      codex.respond(() => reply.error(400, errorBody));
      const via = yield* launchVia({ upstream: codex.url, accounts: pair });

      const response = yield* post(via, "/v1/chat/completions", {
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(response.status).toBe(400);
      expect(yield* json(response)).toEqual(errorBody);
      // A client-fault error is not retried against another account.
      expect(accountsOf(codex)).toEqual(["acc-a"]);
    }),
  );

  it.effect("keeps a conversation on the account that answered it, while new ones fill first", () =>
    Effect.gen(function* () {
      const codex = yield* startCodex;
      codex.respond(() => reply.text("pong"));
      const via = yield* launchVia({ upstream: codex.url, accounts: pair });
      yield* runVia(via.home, ["accounts", "disable", "a"], via.env);
      yield* chat(via, "conversation one");
      yield* runVia(via.home, ["accounts", "enable", "a"], via.env);

      // Its next turn: same opening message, so the same conversation.
      yield* Effect.promise(() =>
        openai(via).chat.completions.create({
          model: "gpt-6-astra",
          messages: [
            { role: "user", content: "conversation one" },
            { role: "assistant", content: "pong" },
            { role: "user", content: "and again" },
          ],
        }),
      );
      yield* chat(via, "conversation two");

      expect(accountsOf(codex)).toEqual(["acc-b", "acc-b", "acc-a"]);
    }),
  );

  it.effect("sends a model only some plans offer to an account whose plan offers it", () =>
    Effect.gen(function* () {
      const codex = yield* startCodex;
      codex.models({ models: [{ slug: "gpt-6-astra" }] }, "acc-a");
      codex.models({ models: [{ slug: "gpt-6-astra" }, { slug: "daybreak" }] }, "acc-b");
      codex.respond(() => reply.text("pong"));
      const via = yield* launchVia({ upstream: codex.url, accounts: pair });

      const ask = (model: string) =>
        Effect.promise(() =>
          openai(via).chat.completions.create({
            model,
            messages: [{ role: "user", content: `ask ${model}` }],
          }),
        );

      yield* ask("daybreak");
      yield* ask("gpt-6-astra");

      expect(accountsOf(codex)).toEqual(["acc-b", "acc-a"]);
    }),
  );
});
