// Test-only: collects what the pool logs, so tests can wait on a line.
import { Deferred, Effect, Logger } from "effect";

/** A line the pool logged. */
type LogLine = { readonly level: string; readonly message: string };

/** A logger that keeps every line, and `logged(text)`, which waits for one containing `text`. */
export const collectLogs = () => {
  const lines: Array<LogLine> = [];
  const waiters: Array<{ text: string; line: Deferred.Deferred<LogLine> }> = [];

  const logger = Logger.make(({ logLevel, message }) => {
    const line: LogLine = {
      level: logLevel,
      message: (Array.isArray(message) ? message : [message]).join(" "),
    };

    lines.push(line);

    for (const waiter of waiters.filter(({ text }) => line.message.includes(text))) {
      Deferred.doneUnsafe(waiter.line, Effect.succeed(line));
    }
  });

  const logged = (text: string) =>
    Effect.suspend(() => {
      const line = lines.find((seen) => seen.message.includes(text));

      if (line !== undefined) return Effect.succeed(line);
      const waiter = { text, line: Deferred.makeUnsafe<LogLine>() };
      waiters.push(waiter);

      return Deferred.await(waiter.line);
    });

  /** Forgets every line so far, so `logged` waits for a new one. */
  const forget = Effect.sync(() => void lines.splice(0));

  return { logger, logged, forget };
};
