import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { codexFixture, type Reply, reply } from "@via/codex-upstream/testing";
import { Deferred, Effect, Fiber } from "effect";
import {
  type Codex,
  freePort,
  openai,
  realTime,
  startCodex,
  type Via,
  launchVia,
} from "./harness.ts";

// Faults a real Codex connection produces, and what a client must see for
// each: an OpenAI-shaped error, never a reset or a hang, and a via that keeps
// serving afterwards.
const MODEL = "gpt-6-astra";

const CHAT = "/v1/chat/completions";

const RESPONSES = "/v1/responses";

const chatBody = (stream: boolean) => ({
  model: MODEL,
  stream,
  messages: [{ role: "user", content: "ping" }],
});

const responsesBody = (stream: boolean) => ({ model: MODEL, stream, input: "ping" });

// The SDK can't send a broken body or show raw frames, so faults go through fetch.
const post = (via: Via, path: string, body: string, signal?: AbortSignal) =>
  Effect.promise(() =>
    fetch(`${via.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${via.key}` },
      body,
      ...(signal !== undefined && { signal }),
    }),
  );

/** The whole body, or the reason reading it failed (a reset is a finding). */
const read = (response: Response) =>
  Effect.promise(() =>
    response.text().then(
      (text) => ({ text, reset: false }),
      () => ({ text: "", reset: true }),
    ),
  );

type Frame = { event: string | undefined; data: string };

const frames = (text: string): ReadonlyArray<Frame> =>
  text
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => ({
      event: /^event: (.*)$/m.exec(block)?.[1],
      data: /^data: (.*)$/m.exec(block)?.[1] ?? "",
    }));

/** A normal request on the same via still succeeds. */
const stillServes = (via: Via, codex: Codex) =>
  Effect.gen(function* () {
    codex.script(reply.text("pong"));

    const completion = yield* Effect.promise(() =>
      openai(via).chat.completions.create({
        model: MODEL,
        messages: [{ role: "user", content: "ping" }],
      }),
    ).pipe(Effect.timeout("5 seconds"), realTime);

    expect(completion.choices[0]?.message.content).toBe("pong");
  });

/** Runs `body` against a via whose Codex answers first with `fault`, if any. */
const faulted = <A, E, R>(
  fault: Reply | undefined,
  body: (via: Via, codex: Codex) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const codex = yield* startCodex;

    if (fault !== undefined) codex.script(fault);
    const via = yield* launchVia({ upstream: codex.url });
    yield* body(via, codex);
    yield* stillServes(via, codex);
  });

const cutOff = reply.truncated(reply.text("pong"), 5);

const hungUp = reply.hangUp(reply.text("pong"), 5);

const failed = reply.failed("server_is_overloaded", "Codex is overloaded");

layer(BunFileSystem.layer)("resilience", (it) => {
  for (const [name, fault, code] of [
    ["cut off", cutOff, "upstream_incomplete"],
    ["reset", hungUp, "upstream_incomplete"],
    ["failed", failed, "server_is_overloaded"],
  ] as const) {
    it.effect(`a chat stream Codex ${name} ends in an error chunk, not [DONE]`, () =>
      faulted(fault, (via) =>
        Effect.gen(function* () {
          const outcome = yield* read(yield* post(via, CHAT, JSON.stringify(chatBody(true))));
          expect(outcome.reset).toBe(false);
          const all = frames(outcome.text);
          expect(all.filter((frame) => frame.data.startsWith('{"error"'))).toHaveLength(1);
          expect(all.some((frame) => frame.data === "[DONE]")).toBe(false);
          const last = all.at(-1);
          expect(JSON.parse(last?.data ?? "null")).toMatchObject({
            error: { type: "server_error", code },
          });
        }),
      ),
    );

    for (const [path, body] of [
      [CHAT, chatBody(false)],
      [RESPONSES, responsesBody(false)],
    ] as const) {
      it.effect(`a non-streaming ${path} Codex ${name} answers 502 ${code}`, () =>
        faulted(fault, (via) =>
          Effect.gen(function* () {
            const response = yield* post(via, path, JSON.stringify(body));
            expect(response.status).toBe(502);
            expect(yield* Effect.promise(() => response.json())).toMatchObject({
              error: { type: "server_error", code, message: expect.any(String) },
            });
          }),
        ),
      );
    }
  }

  for (const [name, fault] of [
    ["cut off", cutOff],
    ["reset", hungUp],
  ] as const) {
    it.effect(`a Responses stream Codex ${name} ends in an error event`, () =>
      faulted(fault, (via) =>
        Effect.gen(function* () {
          const outcome = yield* read(
            yield* post(via, RESPONSES, JSON.stringify(responsesBody(true))),
          );

          expect(outcome.reset).toBe(false);
          const all = frames(outcome.text);
          expect(all.filter((frame) => frame.event === "error")).toHaveLength(1);
          const last = all.at(-1);
          expect(last?.event).toBe("error");
          expect(JSON.parse(last?.data ?? "null")).toMatchObject({
            type: "error",
            code: "upstream_incomplete",
          });
        }),
      ),
    );
  }

  it.effect("a Responses stream passes Codex's response.failed through as the last event", () =>
    Effect.gen(function* () {
      const fixture = yield* codexFixture("response-failed-context-length.sse");
      yield* faulted(reply.sse(fixture), (via) =>
        Effect.gen(function* () {
          const outcome = yield* read(
            yield* post(via, RESPONSES, JSON.stringify(responsesBody(true))),
          );

          expect(frames(outcome.text).at(-1)?.event).toBe("response.failed");
        }),
      );
    }),
  );

  for (const path of [CHAT, RESPONSES]) {
    it.effect(`an unreachable Codex answers ${path} with 502 upstream_unavailable`, () =>
      Effect.gen(function* () {
        const closed = `http://127.0.0.1:${yield* freePort}`;
        const via = yield* launchVia({ upstream: closed });

        for (const _ of [1, 2]) {
          const response = yield* post(via, path, JSON.stringify(chatBody(false)));
          expect(response.status).toBe(502);
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            error: { type: "server_error", code: "upstream_unavailable" },
          });
        }
      }),
    );

    for (const [what, body] of [
      ["malformed JSON", "{not json"],
      ["a body that is not an object", "[1, 2, 3]"],
    ] as const) {
      it.effect(`${path} answers ${what} with 400 invalid_request`, () =>
        faulted(undefined, (via, codex) =>
          Effect.gen(function* () {
            const response = yield* post(via, path, body);
            expect(response.status).toBe(400);
            expect(yield* Effect.promise(() => response.json())).toMatchObject({
              error: { type: "invalid_request_error", code: "invalid_request" },
            });
            expect(codex.requests).toHaveLength(0);
          }),
        ),
      );
    }
  }

  it.effect("a client abandoning a stream frees via for the next request", () =>
    faulted(reply.stalled(reply.text("pong"), 3), (via, codex) =>
      Effect.gen(function* () {
        const abort = new AbortController();
        const response = yield* post(via, CHAT, JSON.stringify(chatBody(true)), abort.signal);
        const reader = response.body!.getReader();
        yield* Effect.promise(() => reader.read());
        abort.abort();
        yield* Effect.promise(() => reader.cancel().catch(() => undefined));
        expect(codex.requests).toHaveLength(1);
      }),
    ),
  );

  it.effect("a slow Codex answer is waited for", () =>
    Effect.gen(function* () {
      const codex = yield* startCodex;
      const gate = yield* Deferred.make<void>();
      codex.script(reply.held(gate, reply.text("late")));
      const via = yield* launchVia({ upstream: codex.url });

      const pending = yield* Effect.promise(() =>
        openai(via).chat.completions.create({
          model: MODEL,
          messages: [{ role: "user", content: "ping" }],
        }),
      ).pipe(Effect.forkChild);

      yield* codex.received(1);
      yield* Deferred.succeed(gate, undefined);
      expect((yield* Fiber.join(pending)).choices[0]?.message.content).toBe("late");
    }),
  );
});
