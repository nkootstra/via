import { Clock, Duration, Effect, Ref, Stream } from "effect";

/** An SSE comment: clients skip it, but it keeps the connection from looking idle. */
const PING = new TextEncoder().encode(": keepalive\n\n");

// Bun closes a connection that sends nothing for 10 seconds (its `idleTimeout`),
// and so do some proxies, sooner or later. A model can reason for longer than that
// before its next event, so a quiet stream gets a comment well within it.
const QUIET = Duration.seconds(5);

const LF = 10;

/** Whether `chunk` ends an SSE event, the only place a comment can go. */
const endsEvent = (chunk: Uint8Array) => chunk.at(-1) === LF && chunk.at(-2) === LF;

/**
 * `body`, an SSE stream, with a `: keepalive` comment after every five quiet
 * seconds between its events. It ends when `body` does.
 */
export const keepAlive = <E, R>(body: Stream.Stream<Uint8Array, E, R>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const quiet = yield* Ref.make({ since: yield* Clock.currentTimeMillis, betweenEvents: true });

      const noted = (betweenEvents: boolean) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Ref.set(quiet, { since: now, betweenEvents }),
        );

      const pings = Stream.tick("1 second").pipe(
        Stream.filterEffect(() =>
          Effect.gen(function* () {
            const { since, betweenEvents } = yield* Ref.get(quiet);

            const due =
              betweenEvents && (yield* Clock.currentTimeMillis) - since >= Duration.toMillis(QUIET);

            if (due) yield* noted(true);

            return due;
          }),
        ),
        Stream.as(PING),
      );

      return Stream.merge(body.pipe(Stream.tap((chunk) => noted(endsEvent(chunk)))), pings, {
        haltStrategy: "left",
      });
    }),
  );
