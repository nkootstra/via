import { Stream } from "effect";
import { Sse } from "effect/unstable/encoding";

const TERMINAL = new Set(["response.completed", "response.failed", "response.incomplete"]);

// The Responses API's stream error event, which clients such as the openai SDK raise.
const incomplete = Sse.encoder.write({
  _tag: "Event",
  event: "error",
  id: undefined,
  data: JSON.stringify({
    type: "error",
    code: "upstream_incomplete",
    message: "The Codex stream ended before the response completed",
    param: null,
  }),
});

/**
 * Relays a Codex Responses SSE stream to a client event by event. A stream
 * that breaks off before its terminal event ends in an `error` event, so the
 * client does not mistake it for a finished response.
 */
export const relayStream = <E>(body: Stream.Stream<Uint8Array, E>) =>
  body.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.mapAccum(
      () => false,
      (ended, event) => [ended || TERMINAL.has(event.event), [Sse.encoder.write(event)]],
      { onHalt: (ended) => (ended ? [] : [incomplete]) },
    ),
    Stream.orElseSucceed(() => incomplete),
    Stream.encodeText,
  );
