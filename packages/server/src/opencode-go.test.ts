import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { providerReply } from "@via/providers/testing";
import { Clock, Effect } from "effect";
import { TestClock } from "effect/testing";
import { ok, type Via, withVia } from "./testing/harness.ts";

const keys = { opencodeGoKeys: ["sk-go-1", "sk-go-2"] };

const served = (id: string) => providerReply.json({ id });

/** The API key each request to the fake provider was sent with, in order. */
const keysUsed = (via: Via) =>
  via.provider.requests.map(({ headers }) => headers["authorization"]?.replace("Bearer ", ""));

const ask = (via: Via, session = "ses_1", path = "/v1/chat/completions") =>
  via.post(
    path,
    path === "/v1/responses"
      ? { model: "opencode-go/kimi-k3", input: "hi" }
      : { model: "opencode-go/kimi-k3", messages: [{ role: "user", content: "hi" }] },
    undefined,
    { "x-opencode-session": session },
  );

layer(BunFileSystem.layer)("OpenCode Go accounts", (it) => {
  it.effect("sends a request with the first account's key", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(served("one"));
          expect(yield* (yield* ask(via)).json).toEqual({ id: "one" });
          expect(keysUsed(via)).toEqual(["sk-go-1"]);
        }),
      keys,
    ),
  );

  it.effect("fails over to the next account when one is rate limited, and leaves it resting", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(
            providerReply.byKey({
              "sk-go-1": providerReply.rateLimited(),
              "sk-go-2": served("two"),
            }),
          );

          for (const path of ["/v1/chat/completions", "/v1/responses"]) {
            const response = yield* ask(via, "ses_1", path);
            expect(response.status).toBe(200);
            expect(yield* response.json).toEqual({ id: "two" });
          }

          expect(keysUsed(via)).toEqual(["sk-go-1", "sk-go-2", "sk-go-2"]);
          expect((yield* via.logged("go-1 is cooling down")).level).toBe("Warn");
        }),
      keys,
    ),
  );

  it.effect("fails over at once, without waiting for a slow usage lookup", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          // OpenCode Go never answers the usage lookup a 429 starts.
          via.provider.holdUsage(Effect.never);
          via.provider.respond(
            providerReply.byKey({
              "sk-go-1": providerReply.rateLimited(),
              "sk-go-2": served("two"),
            }),
          );

          expect(yield* (yield* ask(via)).json).toEqual({ id: "two" });
          expect(yield* (yield* ask(via, "ses_2")).json).toEqual({ id: "two" });
          expect(keysUsed(via)).toEqual(["sk-go-1", "sk-go-2", "sk-go-2"]);
        }),
      keys,
    ),
  );

  it.effect("rests a rate-limited account until its used-up usage window resets", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const reset = (yield* Clock.currentTimeMillis) + 3 * 3_600_000;
          via.provider.usageFor("sk-go-1", {
            usage: {
              weekly: {
                status: "rate-limited",
                percent: 100,
                resetsAt: new Date(reset).toISOString(),
              },
            },
          });
          let limited = true;
          via.provider.respond(
            providerReply.byKey({
              "sk-go-1": (request) =>
                (limited ? providerReply.rateLimited() : served("one"))(request),
              "sk-go-2": served("two"),
            }),
          );

          yield* ask(via, "first");
          limited = false;
          // The usage is asked in the background, after the request has failed over.
          expect((yield* via.logged("weekly_exhausted")).message).toContain("go-1 is cooling down");
          yield* TestClock.adjust("2 hours");
          expect(yield* (yield* ask(via, "second")).json).toEqual({ id: "two" });
          yield* TestClock.adjust("1 hour");
          expect(yield* (yield* ask(via, "third")).json).toEqual({ id: "one" });
        }),
      keys,
    ),
  );

  it.effect("rests a rate-limited account as long as its Retry-After asks", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          let limited = true;
          via.provider.respond(
            providerReply.byKey({
              "sk-go-1": (request) =>
                (limited ? providerReply.rateLimited({ "retry-after": "120" }) : served("one"))(
                  request,
                ),
              "sk-go-2": served("two"),
            }),
          );

          yield* ask(via, "first");
          limited = false;
          yield* TestClock.adjust("119 seconds");
          expect(yield* (yield* ask(via, "second")).json).toEqual({ id: "two" });
          yield* TestClock.adjust("1 second");
          expect(yield* (yield* ask(via, "third")).json).toEqual({ id: "one" });
        }),
      keys,
    ),
  );

  it.effect("keeps a conversation on the account that served it, for its prompt cache", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          let limited = true;
          via.provider.respond(
            providerReply.byKey({
              "sk-go-1": (request) =>
                (limited ? providerReply.rateLimited({ "retry-after": "60" }) : served("one"))(
                  request,
                ),
              "sk-go-2": served("two"),
            }),
          );

          yield* ask(via, "ses_long");
          limited = false;
          yield* TestClock.adjust("2 minutes");
          // go-1 is back, but the conversation stays where its cache is warm.
          expect(yield* (yield* ask(via, "ses_long")).json).toEqual({ id: "two" });
          expect(yield* (yield* ask(via, "ses_new")).json).toEqual({ id: "one" });
        }),
      keys,
    ),
  );

  it.effect("answers 429 with Retry-After once every account is resting", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(
            providerReply.byKey({
              "sk-go-1": providerReply.rateLimited({ "retry-after": "60" }),
              "sk-go-2": providerReply.rateLimited({ "retry-after": "120" }),
            }),
          );

          const response = yield* ask(via);
          expect(response.status).toBe(429);
          expect(response.headers["retry-after"]).toBe("60");
          expect(yield* response.json).toMatchObject({
            error: {
              code: "rate_limit_exceeded",
              message: "Every OpenCode Go account is cooling down",
            },
          });
        }),
      keys,
    ),
  );

  it.effect("answers 503 when there is no OpenCode Go account", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* ask(via);
          expect(response.status).toBe(503);
          expect(yield* response.json).toMatchObject({ error: { code: "no_accounts" } });
          expect(via.provider.requests).toEqual([]);
        }),
      { opencodeGoKeys: [] },
    ),
  );

  it.effect("locks out an account whose key is refused and fails over", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(
            providerReply.byKey({
              "sk-go-1": providerReply.json({ error: { message: "bad key" } }, 401),
              "sk-go-2": served("two"),
            }),
          );

          expect(yield* (yield* ask(via, "first")).json).toEqual({ id: "two" });
          yield* TestClock.adjust("1 day");
          expect(yield* (yield* ask(via, "second")).json).toEqual({ id: "two" });
          expect(keysUsed(via)).toEqual(["sk-go-1", "sk-go-2", "sk-go-2"]);
        }),
      keys,
    ),
  );

  it.effect("passes any other error through without failing over", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(providerReply.json({ error: { message: "bad model" } }, 400));
          expect((yield* ask(via)).status).toBe(400);
          expect(keysUsed(via)).toEqual(["sk-go-1"]);
        }),
      keys,
    ),
  );

  it.effect("fails over a streamed request before any of it is sent", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
          via.provider.respond(
            providerReply.byKey({
              "sk-go-1": providerReply.rateLimited(),
              "sk-go-2": providerReply.sse(sse),
            }),
          );

          const response = yield* via.post("/v1/chat/completions", {
            model: "opencode-go/kimi-k3",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          });

          expect(yield* response.text).toBe(sse);
        }),
      keys,
    ),
  );
});
