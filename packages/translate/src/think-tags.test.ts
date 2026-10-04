import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import {
  splitThink,
  thinkSeparatedJson,
  thinkSeparatedStream,
  thinkSplitter,
} from "./think-tags.ts";

/** `text` cut at `cuts`, each taken modulo its length, as a stream's chunks might come. */
const chunked = (text: string, cuts: ReadonlyArray<number>) => {
  const at = [...new Set(cuts.map((cut) => Math.abs(cut) % (text.length + 1)))].toSorted(
    (a, b) => a - b,
  );

  return [0, ...at].map((start, index) => text.slice(start, at[index] ?? text.length));
};

/** What a splitter makes of `chunks`, fed one at a time and then flushed. */
const fed = (chunks: ReadonlyArray<string>) => {
  const split = thinkSplitter();
  const parts = [...chunks.map(split.feed), split.flush()];

  return {
    reasoning: parts.map((part) => part.reasoning).join(""),
    content: parts.map((part) => part.content).join(""),
  };
};

const Cuts = Schema.Array(Schema.Int);

describe("splitThink", () => {
  it("moves a leading think block to the reasoning", () => {
    expect(splitThink("<think>\nThe user wants OK.\n</think>\n\nOK")).toEqual({
      reasoning: "\nThe user wants OK.\n",
      content: "OK",
    });
  });

  it("leaves an answer that doesn't start with a think block alone", () => {
    expect(splitThink("Use <think> tags like this.")).toEqual({
      reasoning: "",
      content: "Use <think> tags like this.",
    });
  });

  it("keeps a think block that never closes as reasoning", () => {
    expect(splitThink("<think>still going")).toEqual({ reasoning: "still going", content: "" });
  });
});

describe("thinkSplitter", () => {
  it("holds back a tag cut across chunks until it can tell", () => {
    expect(fed(["<thi", "nk>why</thi", "nk>OK"])).toEqual({ reasoning: "why", content: "OK" });
  });

  it.prop(
    "splits a think block the same however the stream is chunked",
    {
      reasoning: Schema.String.check(Schema.makeFilter((text) => !text.includes("</think>"))),
      answer: Schema.String,
      cuts: Cuts,
    },
    ({ reasoning, answer, cuts }) => {
      const text = `<think>${reasoning}</think>\n\n${answer}`;

      expect(fed(chunked(text, cuts))).toEqual({ reasoning, content: answer.trimStart() });
    },
  );

  it.prop(
    "passes an answer that doesn't start with a think block through whole",
    {
      answer: Schema.String.check(
        Schema.makeFilter((text) => !text.trimStart().startsWith("<think>")),
      ),
      cuts: Cuts,
    },
    ({ answer, cuts }) => {
      expect(fed(chunked(answer, cuts))).toEqual({ reasoning: "", content: answer });
    },
  );
});

const chunk = (delta: Schema.JsonObject, finish_reason: string | null = null) => ({
  id: "c1",
  object: "chat.completion.chunk",
  model: "minimax-m3",
  choices: [{ index: 0, delta, finish_reason }],
});

const DONE = "data: [DONE]\n\n";

const sse = (events: ReadonlyArray<Schema.JsonObject>, done = DONE) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + done;

/** `text` as a stream of byte chunks cut every `size` characters. */
const bytes = (text: string, size: number) =>
  Stream.fromIterable(
    Array.from({ length: Math.ceil(text.length / size) }, (_, index) =>
      new TextEncoder().encode(text.slice(index * size, (index + 1) * size)),
    ),
  );

describe("thinkSeparatedStream", () => {
  it.effect("moves a streamed think block into reasoning_content, cut wherever", () =>
    Effect.gen(function* () {
      const upstream = sse([
        chunk({ role: "assistant", content: "<think>\nThe user wants" }),
        chunk({ content: " OK.\n</think>\nOK" }, "stop"),
      ]);

      for (const size of [1, 7, upstream.length]) {
        const relayed = yield* thinkSeparatedStream(bytes(upstream, size)).pipe(
          Stream.decodeText,
          Stream.mkString,
        );

        expect(relayed).toBe(
          sse([
            chunk({ role: "assistant", content: "", reasoning_content: "\nThe user wants" }),
            chunk({ content: "OK", reasoning_content: " OK.\n" }, "stop"),
          ]),
        );
      }
    }),
  );

  it.effect("leaves a stream without a think block as it came", () =>
    Effect.gen(function* () {
      const upstream = sse([
        chunk({ role: "assistant", reasoning_content: "Hmm" }),
        chunk({ content: "OK" }, "stop"),
      ]);

      expect(
        yield* thinkSeparatedStream(bytes(upstream, 5)).pipe(Stream.decodeText, Stream.mkString),
      ).toBe(upstream);
    }),
  );
});

describe("thinkSeparatedJson", () => {
  it("moves a completion's think block into reasoning_content", () => {
    const completion = {
      id: "c1",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "<think>Easy.</think>\n\nOK" },
          finish_reason: "stop",
        },
      ],
    };

    expect(JSON.parse(thinkSeparatedJson(JSON.stringify(completion)))).toEqual({
      id: "c1",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OK", reasoning_content: "Easy." },
          finish_reason: "stop",
        },
      ],
    });
  });

  it("leaves any other body as it came", () => {
    for (const body of ['{"error":{"message":"no"}}', "not json", '{"choices":[]}']) {
      expect(thinkSeparatedJson(body)).toBe(body);
    }
  });
});
