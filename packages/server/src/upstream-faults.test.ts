import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply, sse } from "@via/codex-upstream/testing";
import { Effect } from "effect";
import { withVia } from "./harness.ts";

// What a client sees when Codex breaks: an OpenAI-shaped server error.
const response = {
  id: "resp_1",
  created_at: 1_700_000_000,
  model: "gpt-6-astra",
};

const created = {
  type: "response.created",
  response: { ...response, status: "in_progress" },
};

const cutOff = () => reply.sse(sse([created]));

const failed = () =>
  reply.sse(
    sse([
      created,
      {
        type: "response.failed",
        response: {
          ...response,
          status: "failed",
          error: { code: "server_is_overloaded", message: "Codex is busy" },
        },
      },
    ]),
  );

const CHAT = "/v1/chat/completions";

const RESPONSES = "/v1/responses";

const bodies = {
  [CHAT]: { model: "gpt-6-astra", messages: [{ role: "user", content: "hi" }] },
  [RESPONSES]: { model: "gpt-6-astra", input: "hi" },
};

layer(BunFileSystem.layer)("upstream faults", (it) => {
  for (const path of [CHAT, RESPONSES] as const) {
    it.effect(`${path} answers a cut-off Codex stream with 502 upstream_incomplete`, () =>
      withVia(cutOff, (via) =>
        Effect.gen(function* () {
          const answer = yield* via.post(path, bodies[path]);
          expect(answer.status).toBe(502);
          expect(yield* answer.json).toMatchObject({
            error: { type: "server_error", code: "upstream_incomplete" },
          });
        }),
      ),
    );

    it.effect(`${path} answers a failed Codex response with 502 and its code`, () =>
      withVia(failed, (via) =>
        Effect.gen(function* () {
          const answer = yield* via.post(path, bodies[path]);
          expect(answer.status).toBe(502);
          expect(yield* answer.json).toMatchObject({
            error: {
              type: "server_error",
              code: "server_is_overloaded",
              message: "Codex is busy",
            },
          });
        }),
      ),
    );

    it.effect(`${path} answers a garbled Codex stream with 502 upstream_incomplete`, () =>
      withVia(
        () => reply.sse(`${sse([created])}event: response.completed\ndata: {not json\n\n`),
        (via) =>
          Effect.gen(function* () {
            const answer = yield* via.post(path, bodies[path]);
            expect(answer.status).toBe(502);
            expect(yield* answer.json).toMatchObject({
              error: { type: "server_error", code: "upstream_incomplete" },
            });
          }),
      ),
    );

    it.effect(
      `${path} answers a Codex stream asking to be retried with 502 upstream_incomplete`,
      () =>
        withVia(
          () => reply.sse(`${sse([created])}retry: 1000\n\n`),
          (via) =>
            Effect.gen(function* () {
              const answer = yield* via.post(path, bodies[path]);
              expect(answer.status).toBe(502);
              expect(yield* answer.json).toMatchObject({
                error: { type: "server_error", code: "upstream_incomplete" },
              });
            }),
        ),
    );

    it.effect(
      `${path} answers a Codex connection broken mid-stream with 502 upstream_incomplete`,
      () =>
        withVia(
          () => reply.hangUp(reply.text("hello"), 2),
          (via) =>
            Effect.gen(function* () {
              const answer = yield* via.post(path, bodies[path]);
              expect(answer.status).toBe(502);
              expect(yield* answer.json).toMatchObject({
                error: { type: "server_error", code: "upstream_incomplete" },
              });
            }),
        ),
    );

    it.effect(`${path} answers an unreachable Codex with 502 upstream_unavailable`, () =>
      withVia(
        cutOff,
        (via) =>
          Effect.gen(function* () {
            const answer = yield* via.post(path, bodies[path]);
            expect(answer.status).toBe(502);
            expect(yield* answer.json).toMatchObject({
              error: { type: "server_error", code: "upstream_unavailable" },
            });
          }),
        // Nothing listens on port 1, so the connection is refused.
        { codexUrl: "http://127.0.0.1:1" },
      ),
    );
  }

  it.effect(`${RESPONSES} rejects a body that is not an object with 400`, () =>
    withVia(cutOff, (via) =>
      Effect.gen(function* () {
        const answer = yield* via.post(RESPONSES, [1, 2, 3]);
        expect(answer.status).toBe(400);
        expect(yield* answer.json).toMatchObject({
          error: { type: "invalid_request_error", code: "invalid_request" },
        });
        expect(via.upstreamRequests).toHaveLength(0);
      }),
    ),
  );

  it.effect(`a ${RESPONSES} stream cut off by Codex ends in an error event`, () =>
    withVia(cutOff, (via) =>
      Effect.gen(function* () {
        const text = yield* (yield* via.post(RESPONSES, {
          ...bodies[RESPONSES],
          stream: true,
        })).text;

        const frames = text.trim().split("\n\n");
        expect(frames.map((frame) => /^event: (.*)$/m.exec(frame)?.[1])).toEqual([
          "response.created",
          "error",
        ]);
        const last = frames.at(-1) ?? "";
        expect(JSON.parse(last.replace(/^event: error\ndata: /, ""))).toMatchObject({
          type: "error",
          code: "upstream_incomplete",
        });
      }),
    ),
  );

  it.effect(`${CHAT} finishes an incomplete Codex response with length`, () =>
    withVia(
      () =>
        reply.sse(
          sse([
            created,
            {
              type: "response.incomplete",
              response: {
                ...response,
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                output: [
                  {
                    type: "message",
                    content: [{ type: "output_text", text: "Hel" }],
                  },
                ],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ]),
        ),
      (via) =>
        Effect.gen(function* () {
          const answer = yield* via.post(CHAT, bodies[CHAT]);
          expect(answer.status).toBe(200);
          expect(yield* answer.json).toMatchObject({
            choices: [{ message: { content: "Hel" }, finish_reason: "length" }],
          });
        }),
    ),
  );
});
