import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { CodexUpstream, type ResponsesBody } from "./index.ts";
import { reply, startFakeCodex } from "./testing/index.ts";

const account = { accessToken: "at-1", accountId: "acc-1" };

/** Sends one request through CodexUpstream and returns what the fake Codex received. */
const sendAndRecord = (body: ResponsesBody, cloak = true, session = "conv-1") =>
  Effect.gen(function* () {
    const codex = yield* startFakeCodex;
    codex.script(reply.text("hello"));

    const response = yield* Effect.gen(function* () {
      return yield* (yield* CodexUpstream).send(account, body, session);
    }).pipe(
      Effect.provide(
        CodexUpstream.layer({ baseUrl: codex.url, cloak, version: "1.2.3" }).pipe(
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
    );

    return { response, request: codex.requests[0]! };
  });

describe("CodexUpstream.send", () => {
  it.effect("authenticates as the account and asks for a stream", () =>
    Effect.gen(function* () {
      const { request } = yield* sendAndRecord({ model: "gpt-6-astra", input: "hi" });
      expect(request.headers).toMatchObject({
        authorization: "Bearer at-1",
        "chatgpt-account-id": "acc-1",
        accept: "text/event-stream",
      });
    }),
  );

  it.effect("sends the prepared body", () =>
    Effect.gen(function* () {
      const { request } = yield* sendAndRecord({
        model: "gpt-6-astra",
        input: "hi",
        stream: false,
      });

      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.body).toMatchObject({ model: "gpt-6-astra", stream: true, store: false });
    }),
  );

  it.effect("identifies as the Codex TUI by default", () =>
    Effect.gen(function* () {
      const { request } = yield* sendAndRecord({ model: "gpt-6-astra" });
      expect(request.headers.originator).toBe("codex-tui");
      expect(request.headers["user-agent"]).toMatch(/^codex-tui\//);
    }),
  );

  it.effect("identifies as this version of via when cloaking is off", () =>
    Effect.gen(function* () {
      const { request } = yield* sendAndRecord({ model: "gpt-6-astra" }, false);
      expect(request.headers.originator).toBe("via");
      expect(request.headers["user-agent"]).toBe("via/1.2.3");
    }),
  );

  it.effect(
    "sends the session it is given, as prompt_cache_key too unless the client set one",
    () =>
      Effect.gen(function* () {
        const plain = yield* sendAndRecord({ model: "gpt-6-astra" });
        expect(plain.request.headers.session_id).toBe("conv-1");
        expect(plain.request.body["prompt_cache_key"]).toBe("conv-1");
        const keyed = yield* sendAndRecord({ model: "gpt-6-astra", prompt_cache_key: "mine" });
        expect(keyed.request.headers.session_id).toBe("conv-1");
        expect(keyed.request.body["prompt_cache_key"]).toBe("mine");
      }),
  );

  it.effect("returns the upstream response as-is, errors included", () =>
    Effect.gen(function* () {
      const { response } = yield* sendAndRecord({ model: "gpt-6-astra" });
      expect(response.status).toBe(200);
      expect(yield* response.text).toContain("response.completed");
    }),
  );
});

describe("CodexUpstream", () => {
  it.effect("talks to the ChatGPT backend unless given another URL", () =>
    Effect.gen(function* () {
      const urls: Array<string> = [];

      // Nothing leaves the process: every request is recorded and refused.
      const recording = HttpClient.make((request, url) => {
        urls.push(`${url.origin}${url.pathname}`);

        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
        );
      });

      yield* Effect.gen(function* () {
        const codex = yield* CodexUpstream;
        yield* codex.send(account, { model: "gpt-6-astra" }, "conv-1");
        yield* Effect.flip(codex.usage(account));
        yield* Effect.flip(codex.models(account));
      }).pipe(
        Effect.provide(
          CodexUpstream.layer({ cloak: true, version: "1.2.3" }).pipe(
            Layer.provide(Layer.succeed(HttpClient.HttpClient, recording)),
          ),
        ),
      );

      expect(urls).toEqual([
        "https://chatgpt.com/backend-api/codex/responses",
        "https://chatgpt.com/backend-api/wham/usage",
        "https://chatgpt.com/backend-api/codex/models",
      ]);
    }),
  );
});
