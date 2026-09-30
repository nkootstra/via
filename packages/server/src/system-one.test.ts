import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { providerReply } from "@via/providers/testing";
import { Effect, Option } from "effect";
import { ok, withVia } from "./testing/harness.ts";

const question = {
  state: "Our checkout has returned 500 errors since 9am.",
  questions: {
    label: {
      type: "choice",
      instructions: "Which label fits this ticket?",
      criteria: { billing: "Payments and refunds", bug: "Software errors" },
    },
  },
};

const answer = {
  model: "nimble",
  answers: {
    label: {
      type: "choice",
      choice: "bug",
      probabilities: { billing: 0.02, bug: 0.98 },
      confidence: 0.96,
    },
  },
  usage: { input_tokens: 41, output_tokens: 2 },
};

layer(BunFileSystem.layer)("POST /v1/systemone", (it) => {
  it.effect("passes the questions to the provider the model names, and its answer back", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(providerReply.json(answer));

        const response = yield* via.post("/v1/systemone", {
          model: "openrouter/nimble",
          ...question,
        });

        expect(response.status).toBe(200);
        expect(yield* response.json).toEqual(answer);
        expect(via.provider.requests[0]).toMatchObject({
          path: "/systemone",
          body: { model: "nimble", ...question },
        });
      }),
    ),
  );

  it.effect("keeps the request in the usage history, with its tokens", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(providerReply.json(answer));
        yield* (yield* via.post("/v1/systemone", { model: "openrouter/nimble", ...question })).text;
        yield* via.logged("Sent HTTP response");

        const page = yield* via.usage.requests({ from: 0, to: Number.MAX_SAFE_INTEGER, limit: 5 });

        expect(page.requests[0]).toMatchObject({
          model: "openrouter/nimble",
          provider: "openrouter",
          inputTokens: Option.some(41),
          outputTokens: Option.some(2),
        });
      }),
    ),
  );

  it.effect("refuses a model no provider serves it for, such as a Codex one", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/systemone", { model: "gpt-6-astra", ...question });

        expect(response.status).toBe(400);
        expect(yield* response.json).toMatchObject({
          error: {
            code: "invalid_request",
            message:
              "System One goes to a provider that serves it, such as Ollama: ask for a model like ollama/nimble",
          },
        });
        expect(via.upstreamRequests).toEqual([]);
      }),
    ),
  );

  it.effect("needs a via API key", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post(
          "/v1/systemone",
          { model: "openrouter/nimble", ...question },
          null,
        );

        expect(response.status).toBe(401);
      }),
    ),
  );
});
