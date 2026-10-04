import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { type CodexRequest, reply, startFakeCodex } from "@via/codex-upstream/testing";
import { Effect } from "effect";
import { ok, withVia } from "./testing/harness.ts";

const accountOf = (request: CodexRequest) => request.headers["chatgpt-account-id"];

/** A fake Codex where acc-a's plan offers gpt-7 and acc-b's also offers daybreak. */
const plans = Effect.gen(function* () {
  const codex = yield* startFakeCodex;
  codex.respond(ok);
  codex.models({ models: [{ slug: "gpt-7" }] }, "acc-a");
  codex.models(
    {
      models: [
        { slug: "gpt-7" },
        { slug: "daybreak", supported_reasoning_levels: [{ effort: "high" }] },
      ],
    },
    "acc-b",
  );

  return codex;
});

layer(BunFileSystem.layer)("Codex accounts by model", (it) => {
  it.effect("sends a model only some plans offer to an account that offers it", () =>
    Effect.gen(function* () {
      const codex = yield* plans;
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            const response = yield* via.post("/v1/responses", { model: "daybreak", input: "hi" });
            expect(response.status).toBe(200);
            expect(codex.requests.map(accountOf)).toEqual(["acc-b"]);
          }),
        { codexUrl: codex.url },
      );
    }),
  );

  it.effect("looks past an effort suffix for the model it names", () =>
    Effect.gen(function* () {
      const codex = yield* plans;
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            yield* via.post("/v1/chat/completions", {
              model: "daybreak-high",
              messages: [{ role: "user", content: "hi" }],
            });
            expect(codex.requests.map(accountOf)).toEqual(["acc-b"]);
          }),
        { codexUrl: codex.url },
      );
    }),
  );

  it.effect("sends a model whose own name ends in an effort as it is named", () =>
    Effect.gen(function* () {
      const codex = yield* plans;
      codex.models({ models: [{ slug: "gpt-7" }, { slug: "daybreak-max" }] }, "acc-b");
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            yield* via.post("/v1/responses", { model: "daybreak-max", input: "hi" });
            expect(codex.requests.map(accountOf)).toEqual(["acc-b"]);
            expect(codex.requests[0]?.body.model).toBe("daybreak-max");
            expect(codex.requests[0]?.body).not.toHaveProperty("reasoning");
          }),
        { codexUrl: codex.url },
      );
    }),
  );

  it.effect("fills first as usual with a model every plan offers", () =>
    Effect.gen(function* () {
      const codex = yield* plans;
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            yield* via.post("/v1/responses", { model: "gpt-7", input: "hi" });
            expect(codex.requests.map(accountOf)).toEqual(["acc-a"]);
          }),
        { codexUrl: codex.url },
      );
    }),
  );

  it.effect("leaves a model no plan lists to Codex, as a list can be out of date", () =>
    Effect.gen(function* () {
      const codex = yield* plans;
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            yield* via.post("/v1/responses", { model: "gpt-8", input: "hi" });
            expect(codex.requests.map(accountOf)).toEqual(["acc-a"]);
          }),
        { codexUrl: codex.url },
      );
    }),
  );

  it.effect("answers 429 when every account offering the model is cooling down", () =>
    Effect.gen(function* () {
      const codex = yield* plans;
      codex.forAccount("acc-b", reply.error(429, "", { "retry-after": "120" }));
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            const response = yield* via.post("/v1/responses", { model: "daybreak", input: "hi" });
            expect(response.status).toBe(429);
            expect(response.headers["retry-after"]).toBe("120");
            expect(codex.requests.map(accountOf)).toEqual(["acc-b"]);
          }),
        { codexUrl: codex.url },
      );
    }),
  );
  it.effect(
    "refuses the ultra effort, which only the Codex app can run, without asking Codex",
    () =>
      Effect.gen(function* () {
        const codex = yield* startFakeCodex;
        codex.respond(ok);
        codex.models({
          models: [{ slug: "gpt-7", supported_reasoning_levels: [{ effort: "ultra" }] }],
        });
        yield* withVia(
          ok,
          (via) =>
            Effect.gen(function* () {
              const responses = yield* via.post("/v1/responses", {
                model: "gpt-7-ultra",
                input: "hi",
              });

              const chat = yield* via.post("/v1/chat/completions", {
                model: "gpt-7-ultra",
                messages: [{ role: "user", content: "hi" }],
              });

              for (const response of [responses, chat]) {
                expect(response.status).toBe(400);
                expect(yield* response.json).toEqual({
                  error: {
                    message:
                      "The ultra effort only works in the Codex app, which delegates tasks to agents it runs; use gpt-7-max for the most reasoning via can give",
                    type: "invalid_request_error",
                    code: "unsupported_effort",
                  },
                });
              }

              expect(codex.requests).toEqual([]);
            }),
          { codexUrl: codex.url },
        );
      }),
  );
});
