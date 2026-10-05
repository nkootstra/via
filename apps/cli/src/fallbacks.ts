import { FallbackRuleStore, parseRule } from "@via/fallbacks";
import { Console, Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const rules = yield* (yield* FallbackRuleStore).list;

    if (rules.length === 0) {
      return yield* Console.log(
        "No fallbacks. Set one with `via fallbacks set <model> <fallback...>`.",
      );
    }

    // Model ids vary in length; padding them lines up the fallbacks after them.
    const width = Math.max(...rules.map(({ model }) => model.length));

    for (const { model, fallbacks } of rules) {
      yield* Console.log(`${model.padEnd(width)}  -> ${fallbacks.join(" -> ")}`);
    }
  }),
).pipe(Command.withDescription("List the models each model falls back to"));

const set = Command.make(
  "set",
  {
    model: Argument.String("model"),
    fallbacks: Argument.String("fallback").pipe(Argument.variadic({ min: 1 })),
  },
  ({ model, fallbacks }) =>
    Effect.gen(function* () {
      const rule = yield* parseRule({ model, fallbacks });
      yield* (yield* FallbackRuleStore).set(rule);
      yield* Console.log(`${rule.model} falls back to ${rule.fallbacks.join(", then ")}.`);
    }),
).pipe(
  Command.withDescription(
    "Set the models a model falls back to, in order, when it can't serve; replaces its rule",
  ),
);

const remove = Command.make("remove", { model: Argument.String("model") }, ({ model }) =>
  Effect.gen(function* () {
    yield* (yield* FallbackRuleStore).remove(model);
    yield* Console.log(`${model} no longer falls back.`);
  }),
).pipe(Command.withDescription("Remove a model's fallbacks"));

/** `via fallbacks`. */
export const fallbacks = Command.make("fallbacks").pipe(
  Command.withDescription("Manage the models a model falls back to when it can't serve"),
  Command.withSubcommands([list, set, remove]),
);
