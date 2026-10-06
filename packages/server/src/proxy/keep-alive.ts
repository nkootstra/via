import { Clock, Duration, Effect, Ref, Stream } from "effect";

/** An SSE comment: clients skip it, but it keeps the connection from looking idle. */
const PING = new TextEncoder().encode(": keepalive\n\n");

// Proxies close a connection that sends nothing, some after as little as 10
// seconds, as Bun does by default. A model can reason for longer than that before
// its next event, so a quiet stream gets a comment well within it.
const QUIET = Duration.seconds(5);

const decoder = new TextDecoder();

/**
 * The last three bytes of the stream so far, after `chunk`: enough to see a blank line, which
 * ends an event, however the stream split its bytes into chunks.
 */
const tailAfter = (tail: string, chunk: Uint8Array) =>
  (tail + decoder.decode(chunk.subarray(-3))).slice(-3);

/**
 * Whether a stream ending in `tail` is between SSE events, the only place a comment can go:
 * after a blank line, whichever of LF, CRLF or CR ends its lines.
 */
const endsEvent = (tail: string) => /(\n\n|\r\r|\n\r\n)$/.test(tail);

/**
 * `body`, an SSE stream, with a `: keepalive` comment after every five quiet
 * seconds between its events. It ends when `body` does.
 */
export const keepAlive = <E, R>(body: Stream.Stream<Uint8Array, E, R>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const quiet = yield* Ref.make({ since: yield* Clock.currentTimeMillis, betweenEvents: true });
      const tail = yield* Ref.make("");

      const noted = (betweenEvents: boolean) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Ref.set(quiet, { since: now, betweenEvents }),
        );

      const sent = (chunk: Uint8Array) =>
        Effect.flatMap(
          Ref.updateAndGet(tail, (sofar) => tailAfter(sofar, chunk)),
          (last) => noted(endsEvent(last)),
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

      return Stream.merge(body.pipe(Stream.tap(sent)), pings, {
        haltStrategy: "left",
      });
    }),
  );
