import { Stream } from "effect";
import { Sse } from "effect/unstable/encoding";
import { isTerminalEvent, streamIncomplete } from "./responses-events.ts";

// The Responses API's stream error event, which clients such as the openai SDK raise.
const incomplete = Sse.encoder.write(
  Sse.Event.make({
    event: "error",
    id: undefined,
    data: JSON.stringify({
      type: "error",
      ...streamIncomplete,
      param: null,
    }),
  }),
);

/**
 * Relays a Codex Responses SSE stream to a client event by event. A stream
 * that breaks off before its terminal event ends in an `error` event, so the
 * client does not mistake it for a finished response.
 */
export const relayStream = <E>(body: Stream.Stream<Uint8Array, E>) =>
  body.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decode()),
    // Nothing after the terminal event is read, so a late break can't taint it.
    Stream.takeUntil((event) => isTerminalEvent(event.event)),
    // A read that fails ends the stream here, so `onHalt` reports it once.
    Stream.ignore,
    Stream.mapAccum(
      () => false,
      (ended, event) => [ended || isTerminalEvent(event.event), [Sse.encoder.write(event)]],
      { onHalt: (ended) => (ended ? [] : [incomplete]) },
    ),
    Stream.encodeText,
  );
