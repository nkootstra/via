import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Rejection } from "@via/pool";
import { Effect, Stream } from "effect";
import { collectResponse, UpstreamFailedError } from "./index.ts";
import { readRejection } from "./rejection.ts";
import { codexErrorFixture, codexFixture } from "./testing/fixtures.ts";

// Contract tests: codex's own SSE fixtures, verbatim, through via's parser.
// Codex rebuilds a response from `response.output_item.done` events; its
// `response.completed` carries only the id and usage.
const collectFixture = (name: string) =>
  codexFixture(name).pipe(
    Effect.map((text) => Stream.make(new TextEncoder().encode(text))),
    Effect.flatMap(collectResponse),
  );

layer(BunFileSystem.layer)("collectResponse against codex's fixtures", (it) => {
  it.effect("rebuilds a text reply from its finished items", () =>
    Effect.gen(function* () {
      const response = yield* collectFixture("text-reply.sse");
      expect(response).toMatchObject({
        id: "resp-1",
        output: [
          { type: "message", content: [{ type: "output_text", text: "streamed response" }] },
        ],
      });
    }),
  );

  it.effect("rebuilds a function call from its finished item", () =>
    Effect.gen(function* () {
      const response = yield* collectFixture("function-call.sse");
      expect(response["output"]).toEqual([
        expect.objectContaining({
          type: "function_call",
          call_id: "user-input-call",
          name: "request_user_input",
        }),
      ]);
    }),
  );

  it.effect("keeps reasoning and message items in order", () =>
    Effect.gen(function* () {
      const response = yield* collectFixture("reasoning-plus-text.sse");
      expect(response["output"]).toEqual([
        expect.objectContaining({ type: "reasoning" }),
        expect.objectContaining({ type: "message" }),
      ]);
    }),
  );

  it.effect("returns an incomplete response with its reason", () =>
    Effect.gen(function* () {
      const response = yield* collectFixture("response-incomplete.sse");
      expect(response).toMatchObject({
        id: "resp_incomplete",
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
      });
    }),
  );

  it.effect.each([
    { fixture: "response-failed-rate-limit.sse", code: "rate_limit_exceeded" },
    { fixture: "response-failed-quota-exceeded.sse", code: "insufficient_quota" },
    { fixture: "response-failed-context-length.sse", code: "context_length_exceeded" },
    { fixture: "response-failed-server-overloaded.sse", code: "server_is_overloaded" },
  ])("fails $fixture with code $code", ({ fixture, code }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(collectFixture(fixture));
      expect(error).toBeInstanceOf(UpstreamFailedError);
      expect(error).toMatchObject({ code });
    }),
  );
});

const readFixture = (name: string) =>
  Effect.map(codexErrorFixture(name), ({ status, headers, body }) =>
    readRejection(
      status,
      Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
      JSON.stringify(body),
    ),
  );

layer(BunFileSystem.layer)("readRejection against codex's error fixtures", (it) => {
  it.effect("reads a usage limit with its reset time", () =>
    Effect.gen(function* () {
      expect(yield* readFixture("usage_limit_reached")).toEqual(
        Rejection.Exhausted({ reason: "usage_limit_reached", resetsAt: 1_704_067_242_000 }),
      );
    }),
  );

  it.effect("reads a 401 as a refused token", () =>
    Effect.gen(function* () {
      expect(yield* readFixture("unauthorized_401")).toEqual(Rejection.Unauthorized());
    }),
  );

  it.effect("reads an overloaded server by its code", () =>
    Effect.gen(function* () {
      expect(yield* readFixture("server_overloaded_503")).toEqual(
        Rejection.Unavailable({ reason: "server_is_overloaded" }),
      );
    }),
  );

  it.effect("names a server error by its type even when its code is null", () =>
    Effect.gen(function* () {
      expect(yield* readFixture("internal_server_error_500")).toEqual(
        Rejection.Unavailable({ reason: "server_error" }),
      );
    }),
  );
});
