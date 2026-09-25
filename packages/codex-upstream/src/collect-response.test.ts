import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { completedStream, sse } from "./testing/streams.ts";
import { collectResponse, IncompleteStreamError, UpstreamFailedError } from "./index.ts";

/** The SSE text as a byte stream, cut into `size`-byte chunks like a network would. */
const bytes = (text: string, size = 7) => {
  const encoded = new TextEncoder().encode(text);
  const chunks = Array.from({ length: Math.ceil(encoded.length / size) }, (_, i) =>
    encoded.slice(i * size, (i + 1) * size),
  );
  return Stream.fromIterable(chunks);
};

describe("collectResponse", () => {
  it.effect("returns the final response of a completed stream", () =>
    Effect.gen(function* () {
      const response = yield* collectResponse(bytes(completedStream("hello")));
      expect(response).toMatchObject({
        id: "resp_1",
        status: "completed",
        output: [{ content: [{ text: "hello" }] }],
      });
    }),
  );

  it.effect("fails with the upstream error when the response failed", () =>
    Effect.gen(function* () {
      const failed = sse([
        {
          type: "response.failed",
          response: { id: "resp_1", error: { code: "server_error", message: "boom" } },
        },
      ]);
      const error = yield* Effect.flip(collectResponse(bytes(failed)));
      expect(error).toEqual(new UpstreamFailedError({ code: "server_error", reason: "boom" }));
    }),
  );

  it.effect("fails when the stream ends before the response completes", () =>
    Effect.gen(function* () {
      const cut = sse([{ type: "response.created", response: { id: "resp_1" } }]);
      const error = yield* Effect.flip(collectResponse(bytes(cut)));
      expect(error).toBeInstanceOf(IncompleteStreamError);
    }),
  );
});
