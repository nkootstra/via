import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Stream } from "effect";
import { spotUsage, usageOf } from "./token-usage.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("usageOf", () => {
  it("reads a Responses usage object", () => {
    expect(usageOf({ input_tokens: 10, output_tokens: 2, total_tokens: 12 })).toEqual(
      Option.some({ inputTokens: 10, outputTokens: 2 }),
    );
  });

  it("reads a Responses usage object's cached tokens", () => {
    expect(
      usageOf({
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        input_tokens_details: { cached_tokens: 4 },
      }),
    ).toEqual(Option.some({ inputTokens: 10, outputTokens: 2, cachedTokens: 4 }));
  });

  it("reads a Responses usage object whose details are null, as Codex sends them", () => {
    expect(
      usageOf({
        input_tokens: 10,
        input_tokens_details: null,
        output_tokens: 2,
        output_tokens_details: null,
        total_tokens: 12,
      }),
    ).toEqual(Option.some({ inputTokens: 10, outputTokens: 2 }));
  });

  it("reads a Chat Completions usage object", () => {
    expect(usageOf({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 })).toEqual(
      Option.some({ inputTokens: 10, outputTokens: 2 }),
    );
  });

  it("reads a Chat Completions usage object's cached tokens", () => {
    expect(
      usageOf({
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_tokens_details: { cached_tokens: 4 },
      }),
    ).toEqual(Option.some({ inputTokens: 10, outputTokens: 2, cachedTokens: 4 }));
  });

  it("is absent for a value that isn't a usage object", () => {
    expect(usageOf(undefined)).toEqual(Option.none());
    expect(usageOf({ input_tokens: 10 })).toEqual(Option.none());
  });
});

describe("spotUsage", () => {
  it.effect("passes SSE bytes through unchanged", () =>
    Effect.gen(function* () {
      const text =
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2}}}\n\n';

      const stream = spotUsage(Stream.make(bytes(text)), true, () => Effect.void);
      const chunks = yield* Stream.runCollect(stream);
      expect(new TextDecoder().decode(chunks[0])).toBe(text);
    }),
  );

  it.effect("reports the usage a response.completed event carries", () =>
    Effect.gen(function* () {
      const text =
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2,"input_tokens_details":{"cached_tokens":4}}}}\n\n';

      const reported: Array<unknown> = [];

      const stream = spotUsage(Stream.make(bytes(text)), true, (usage) =>
        Effect.sync(() => reported.push(usage)),
      );

      yield* Stream.runDrain(stream);
      expect(reported).toEqual([{ inputTokens: 10, outputTokens: 2, cachedTokens: 4 }]);
    }),
  );

  it.effect("reports the usage a chat completions final SSE chunk carries", () =>
    Effect.gen(function* () {
      const text =
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n';

      const reported: Array<unknown> = [];

      const stream = spotUsage(Stream.make(bytes(text)), true, (usage) =>
        Effect.sync(() => reported.push(usage)),
      );

      yield* Stream.runDrain(stream);
      expect(reported).toEqual([{ inputTokens: 10, outputTokens: 2 }]);
    }),
  );

  it.effect("reports nothing for an SSE stream that never carries usage", () =>
    Effect.gen(function* () {
      const text = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
      const reported: Array<unknown> = [];

      const stream = spotUsage(Stream.make(bytes(text)), true, (usage) =>
        Effect.sync(() => reported.push(usage)),
      );

      yield* Stream.runDrain(stream);
      expect(reported).toEqual([]);
    }),
  );

  it.effect("reports nothing for a response.created event, whose usage is still null", () =>
    Effect.gen(function* () {
      const text =
        'event: response.created\ndata: {"type":"response.created","response":{"status":"in_progress","usage":null}}\n\n';

      const reported: Array<unknown> = [];

      const stream = spotUsage(Stream.make(bytes(text)), true, (usage) =>
        Effect.sync(() => reported.push(usage)),
      );

      yield* Stream.runDrain(stream);
      expect(reported).toEqual([]);
    }),
  );

  it.effect("reports the usage of an SSE event split across chunks", () =>
    Effect.gen(function* () {
      const text =
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n';

      const reported: Array<unknown> = [];
      // The split falls inside the "usage" key itself.
      const at = text.indexOf("usage") + 2;

      const stream = spotUsage(
        Stream.make(bytes(text.slice(0, at)), bytes(text.slice(at))),
        true,
        (usage) => Effect.sync(() => reported.push(usage)),
      );

      yield* Stream.runDrain(stream);
      expect(reported).toEqual([{ inputTokens: 10, outputTokens: 2 }]);
    }),
  );

  it.effect("reports only the final chunk's usage when earlier chunks carry a null one", () =>
    Effect.gen(function* () {
      const text =
        'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n';

      const reported: Array<unknown> = [];

      const stream = spotUsage(Stream.make(bytes(text)), true, (usage) =>
        Effect.sync(() => reported.push(usage)),
      );

      yield* Stream.runDrain(stream);
      expect(reported).toEqual([{ inputTokens: 10, outputTokens: 2 }]);
    }),
  );

  it.effect("skips an SSE retry field and still reports the usage after it", () =>
    Effect.gen(function* () {
      const text =
        'retry: 1000\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n';

      const reported: Array<unknown> = [];

      const stream = spotUsage(Stream.make(bytes(text)), true, (usage) =>
        Effect.sync(() => reported.push(usage)),
      );

      yield* Stream.runDrain(stream);
      expect(reported).toEqual([{ inputTokens: 10, outputTokens: 2 }]);
    }),
  );

  it.effect("does not break the stream on a malformed event", () =>
    Effect.gen(function* () {
      const text = "event: response.completed\ndata: {not json\n\ndata: [DONE]\n\n";
      const reported: Array<unknown> = [];

      const stream = spotUsage(Stream.make(bytes(text)), true, (usage) =>
        Effect.sync(() => reported.push(usage)),
      );

      const chunks = yield* Stream.runCollect(stream);
      expect(new TextDecoder().decode(chunks[0])).toBe(text);
      expect(reported).toEqual([]);
    }),
  );

  it.effect("reports the usage a JSON body carries, once it is complete", () =>
    Effect.gen(function* () {
      const text = '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}';
      const reported: Array<unknown> = [];

      // Split across two chunks, as a real HTTP body would arrive.
      const stream = spotUsage(
        Stream.make(bytes(text.slice(0, 10)), bytes(text.slice(10))),
        false,
        (usage) => Effect.sync(() => reported.push(usage)),
      );

      const chunks = yield* Stream.runCollect(stream);
      expect(chunks.length).toBe(2);
      expect(reported).toEqual([{ inputTokens: 10, outputTokens: 2 }]);
    }),
  );

  it.effect("reports nothing for a JSON body without usage", () =>
    Effect.gen(function* () {
      const text = '{"choices":[]}';
      const reported: Array<unknown> = [];

      const stream = spotUsage(Stream.make(bytes(text)), false, (usage) =>
        Effect.sync(() => reported.push(usage)),
      );

      yield* Stream.runDrain(stream);
      expect(reported).toEqual([]);
    }),
  );

  it.effect("reports usage again each time the same JSON stream value is run", () =>
    Effect.gen(function* () {
      const text = '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}';
      const reported: Array<unknown> = [];

      // The returned Stream is a description, not a one-shot effect: running it
      // twice (as a retry or a replay would) must report both times, not just
      // reuse whatever state the first run left behind.
      const stream = spotUsage(Stream.make(bytes(text)), false, (usage) =>
        Effect.sync(() => reported.push(usage)),
      );

      yield* Stream.runDrain(stream);
      yield* Stream.runDrain(stream);
      expect(reported).toEqual([
        { inputTokens: 10, outputTokens: 2 },
        { inputTokens: 10, outputTokens: 2 },
      ]);
    }),
  );
});
