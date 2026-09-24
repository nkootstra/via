import { AccountStore, CodexAuth } from "@via/codex-auth";
import { Console, Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";

const accountArg = Argument.String("account").pipe(
  Argument.withDescription("Account id, label or email"),
);

const add = Command.make("add", {}, () =>
  Effect.gen(function* () {
    const auth = yield* CodexAuth;
    const code = yield* auth.requestDeviceCode;
    yield* Console.log(`Open ${code.verificationUrl} and enter the code ${code.userCode}`);
    yield* Console.log("Waiting for approval...");
    const saved = yield* (yield* AccountStore).save(yield* auth.awaitDeviceTokens(code));
    yield* Console.log(`Added ${saved.email} (${saved.plan}) as "${saved.label}".`);
  }),
).pipe(Command.withDescription("Log in to a ChatGPT account with a device code"));

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const accounts = yield* (yield* AccountStore).list;
    if (accounts.length === 0)
      return yield* Console.log("No accounts. Add one with `via accounts add`.");
    for (const a of accounts) {
      const status = a.enabled ? "enabled" : "disabled";
      yield* Console.log(`${a.id}  ${a.label}  ${a.email}  ${a.plan}  ${status}`);
    }
  }),
).pipe(Command.withDescription("List accounts in the order they are used"));

const remove = Command.make("remove", { account: accountArg }, ({ account }) =>
  Effect.gen(function* () {
    yield* (yield* AccountStore).remove(account);
    yield* Console.log(`Removed "${account}".`);
  }),
).pipe(Command.withDescription("Forget an account and its tokens"));

const setEnabled = (name: "enable" | "disable", enabled: boolean, description: string) =>
  Command.make(name, { account: accountArg }, ({ account }) =>
    Effect.gen(function* () {
      yield* (yield* AccountStore).setEnabled(account, enabled);
      yield* Console.log(`${enabled ? "Enabled" : "Disabled"} "${account}".`);
    }),
  ).pipe(Command.withDescription(description));

const labelCommand = Command.make(
  "label",
  {
    account: accountArg,
    label: Argument.String("label").pipe(Argument.withDescription("The new label")),
  },
  ({ account, label }) =>
    Effect.gen(function* () {
      yield* (yield* AccountStore).setLabel(account, label);
      yield* Console.log(`Labelled "${account}" as "${label}".`);
    }),
).pipe(Command.withDescription("Rename an account"));

export const accounts = Command.make("accounts").pipe(
  Command.withDescription("Manage the ChatGPT accounts in the pool"),
  Command.withSubcommands([
    add,
    list,
    remove,
    setEnabled("enable", true, "Use an account again"),
    setEnabled("disable", false, "Stop using an account without removing it"),
    labelCommand,
  ]),
);
