import { Context, Effect, Layer, Option, Ref } from "effect";

/** The APIs OpenCode Go serves its models in; each model speaks one of them, or more. */
export type Protocol = "chat" | "responses" | "messages";

/**
 * Which protocol each OpenCode Go model answered in, once it refused another.
 * OpenCode Go doesn't say beforehand: a model asked in a protocol it doesn't
 * speak answers 400 `ModelProtocolUnsupported`, and via tries the next one.
 */
export class ModelProtocols extends Context.Service<
  ModelProtocols,
  {
    /** The protocol `model` last answered in, if via has had to find out. */
    readonly get: (model: string) => Effect.Effect<Option.Option<Protocol>>;
    /** Remembers that `model` answers in `protocol`, so it goes there first next time. */
    readonly set: (model: string, protocol: Protocol) => Effect.Effect<void>;
  }
>()("via/ModelProtocols") {
  /** Kept in memory: a restart costs one refused request per model to find out again. */
  static readonly layer = Layer.effect(
    ModelProtocols,
    Effect.gen(function* () {
      const known = yield* Ref.make(new Map<string, Protocol>());

      return ModelProtocols.of({
        get: (model) => Effect.map(Ref.get(known), (map) => Option.fromUndefinedOr(map.get(model))),
        set: (model, protocol) => Ref.update(known, (map) => new Map(map).set(model, protocol)),
      });
    }),
  );
}
