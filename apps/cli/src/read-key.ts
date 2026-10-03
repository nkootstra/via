import { Effect, Redacted, Schema, Stdio, Stream, String as Str } from "effect";
import { Prompt } from "effect/unstable/cli";

class NoApiKeyError extends Schema.TaggedError<NoApiKeyError>()("NoApiKeyError", {
  provider: Schema.String,
}) {
  override get message() {
    return `No ${this.provider} API key was given`;
  }
}

/**
 * `provider`'s API key: typed in, hidden, at a terminal, else read from
 * standard input, so a script can pipe it in. Never an argument, which would
 * end up in the shell's history and the process list.
 */
export const readApiKey = (provider: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;

    const key = (yield* stdio.stdinIsTerminal)
      ? Redacted.value(yield* Prompt.run(Prompt.Password({ message: `${provider} API key` })))
      : yield* stdio.stdin.pipe(Stream.decodeText, Stream.mkString);

    const trimmed = Str.trim(key);

    if (trimmed === "") return yield* new NoApiKeyError({ provider });

    return Redacted.make(trimmed);
  });
