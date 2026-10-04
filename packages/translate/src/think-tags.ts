import { Effect, Option, Predicate, Schema, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";

const OPEN = "<think>";

const CLOSE = "</think>";

/** Text split into the model's reasoning and its answer. */
export interface Split {
  readonly reasoning: string;
  readonly content: string;
}

const none: Split = { reasoning: "", content: "" };

/** How long the end of `text` is that could still grow into `tag`. */
const partialTail = (text: string, tag: string) => {
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) {
    if (tag.startsWith(text.slice(-length))) return length;
  }

  return 0;
};

/**
 * Splits an answer that some models, such as MiniMax's, start with their
 * reasoning in a `<think>…</think>` block: the block goes to the reasoning, and
 * what follows it, less the blank lines between, to the content. An answer that
 * doesn't start with one, leading whitespace aside, is all content.
 *
 * `feed` takes the answer a piece at a time, as a stream brings it, and holds
 * back only what it can't yet tell apart, such as a tag cut in two; `flush`
 * gives what it held once the answer ends.
 */
export const thinkSplitter = () => {
  let state: "start" | "thinking" | "after" | "answering" = "start";
  let held = "";

  const feed = (text: string): Split => {
    if (state === "answering") return { reasoning: "", content: text };

    held += text;

    if (state === "start") {
      const trimmed = held.trimStart();

      if (trimmed.length === 0 || (trimmed.length < OPEN.length && OPEN.startsWith(trimmed))) {
        return none;
      }

      if (!trimmed.startsWith(OPEN)) {
        state = "answering";
        const content = held;
        held = "";

        return { reasoning: "", content };
      }

      state = "thinking";
      held = trimmed.slice(OPEN.length);
    }

    let reasoning = "";

    if (state === "thinking") {
      const end = held.indexOf(CLOSE);

      if (end === -1) {
        const keep = partialTail(held, CLOSE);
        reasoning = held.slice(0, held.length - keep);
        held = held.slice(held.length - keep);

        return { reasoning, content: "" };
      }

      reasoning = held.slice(0, end);
      held = held.slice(end + CLOSE.length);
      state = "after";
    }

    const content = held.trimStart();
    held = "";

    if (content.length > 0) state = "answering";

    return { reasoning, content };
  };

  const flush = (): Split => {
    const rest = held;
    held = "";

    return state === "thinking"
      ? { reasoning: rest, content: "" }
      : { reasoning: "", content: rest };
  };

  return { feed, flush };
};

/** A whole answer split as `thinkSplitter` splits one that streams. */
export const splitThink = (text: string): Split => {
  const split = thinkSplitter();
  const first = split.feed(text);
  const last = split.flush();

  return {
    reasoning: first.reasoning + last.reasoning,
    content: first.content + last.content,
  };
};

const readJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject));

const hasChoices = Schema.is(Schema.Struct({ choices: Schema.Array(Schema.JsonObject) }));

const isChoice = Schema.is(
  Schema.Struct({
    index: Schema.Finite,
    delta: Schema.optionalKey(Schema.JsonObject),
    message: Schema.optionalKey(Schema.JsonObject),
    finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);

/**
 * `part` (a chunk's delta or a completion's message) with `split` in place of
 * its content, and the reasoning after any it already had; unchanged when
 * the split left its content as it was.
 */
const withSplit = (part: Schema.JsonObject, split: Split): Schema.JsonObject => {
  const before = part["content"];

  if (
    split.reasoning.length === 0 &&
    (split.content === before || (split.content === "" && !Predicate.isString(before)))
  ) {
    return part;
  }

  const had = part["reasoning_content"];

  return {
    ...part,
    content: split.content,
    ...(split.reasoning.length > 0 && {
      reasoning_content: (Predicate.isString(had) ? had : "") + split.reasoning,
    }),
  };
};

const joined = (first: Split, second: Split): Split => ({
  reasoning: first.reasoning + second.reasoning,
  content: first.content + second.content,
});

/**
 * A Chat Completions SSE stream with each choice's leading `<think>` block, as
 * `thinkSplitter` finds it, moved from its `content` deltas into
 * `reasoning_content`, the field other models stream their reasoning in. A
 * choice's held text goes out with its `finish_reason`. Events left as they
 * were keep their data as the upstream sent it.
 */
export const thinkSeparatedStream = <E>(
  body: Stream.Stream<Uint8Array, E>,
): Stream.Stream<Uint8Array, E> =>
  // Built fresh for each run of the stream, as its splitters hold that run's text.
  Stream.unwrap(
    Effect.sync(() => {
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const splitters = new Map<number, ReturnType<typeof thinkSplitter>>();
      let out = "";

      const separated = (data: string) =>
        Option.match(readJson(data), {
          onNone: () => data,
          onSome: (event) => {
            if (!hasChoices(event)) return data;

            let changed = false;

            const choices = event.choices.map((choice) => {
              if (!isChoice(choice)) return choice;

              const delta = choice.delta ?? {};
              const content = delta["content"];
              const ends = Predicate.isString(choice.finish_reason);

              if (!Predicate.isString(content) && !ends) return choice;

              const splitter = splitters.get(choice.index) ?? thinkSplitter();
              splitters.set(choice.index, splitter);

              const fed = Predicate.isString(content) ? splitter.feed(content) : none;

              const split = ends ? joined(fed, splitter.flush()) : fed;
              const after = withSplit(delta, split);

              if (after === delta) return choice;

              changed = true;

              return { ...choice, delta: after };
            });

            return changed ? JSON.stringify({ ...event, choices }) : data;
          },
        });

      const parser = Sse.makeParser((event) => {
        out += Sse.encoder.write(
          Sse.Retry.is(event) ? event : { ...event, data: separated(event.data) },
        );
      });

      return body.pipe(
        Stream.map((chunk) => {
          parser.feed(decoder.decode(chunk, { stream: true }));
          const text = out;
          out = "";

          return encoder.encode(text);
        }),
        Stream.filter((chunk) => chunk.length > 0),
      );
    }),
  );

/**
 * A Chat Completions body with each choice's message split as
 * `thinkSeparatedStream` splits a stream's; any other body as it came.
 */
export const thinkSeparatedJson = (body: string): string =>
  Option.match(readJson(body), {
    onNone: () => body,
    onSome: (completion) => {
      if (!hasChoices(completion)) return body;

      let changed = false;

      const choices = completion.choices.map((choice) => {
        if (!isChoice(choice) || choice.message === undefined) return choice;

        const content = choice.message["content"];

        if (!Predicate.isString(content)) return choice;

        const after = withSplit(choice.message, splitThink(content));

        if (after === choice.message) return choice;

        changed = true;

        return { ...choice, message: after };
      });

      return changed ? JSON.stringify({ ...completion, choices }) : body;
    },
  });
