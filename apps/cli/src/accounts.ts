import { type Account, AccountStore, AccountTokens, CodexAuth } from "@via/codex-auth";
import { CodexUpstream, type UsageWindow } from "@via/codex-upstream";
import { loadConfig } from "@via/config";
import { Console, Effect, Layer } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { codexUpstream } from "./upstream.ts";

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

const noAccounts = "No accounts. Add one with `via accounts add`.";

const describe = (a: Account) =>
  `${a.id}  ${a.label}  ${a.email}  ${a.plan}  ${a.enabled ? "enabled" : "disabled"}`;

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const accounts = yield* (yield* AccountStore).list;
    if (accounts.length === 0) return yield* Console.log(noAccounts);
    for (const a of accounts) yield* Console.log(describe(a));
  }),
).pipe(Command.withDescription("List accounts in the order they are used"));

const pad = (n: number) => String(n).padStart(2, "0");

/** A window as `5h    12% used  resets 2023-11-14 23:13`, in local time. */
const formatWindow = ({ windowMinutes, usedPercent, resetsAt }: UsageWindow) => {
  const length = windowMinutes % 1440 === 0 ? `${windowMinutes / 1440}d` : `${windowMinutes / 60}h`;
  const at = new Date(resetsAt);
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `  ${length.padEnd(4)} ${String(usedPercent).padStart(3)}% used  resets ${date} ${time}`;
};

const showUsage = Effect.fnUntraced(function* (account: Account) {
  yield* Console.log(describe(account));
  const tokens = yield* AccountTokens;
  const codex = yield* CodexUpstream;
  const lines = yield* tokens.fresh(account).pipe(
    Effect.flatMap(codex.usage),
    Effect.map((windows) => windows.map(formatWindow)),
    Effect.catchTags({
      RefreshRejectedError: (error) => Effect.succeed([`  ${error.message}`]),
      UsageUnavailableError: (error) => Effect.succeed([`  ${error.message}`]),
    }),
  );
  for (const line of lines) yield* Console.log(line);
});

const status = (configPath: string, upstreamBaseUrl: string | undefined) =>
  Command.make("status", {}, () =>
    Effect.gen(function* () {
      const config = yield* loadConfig(configPath);
      const accounts = yield* (yield* AccountStore).list;
      if (accounts.length === 0) return yield* Console.log(noAccounts);
      yield* Effect.forEach(accounts, showUsage, { discard: true }).pipe(
        Effect.provide(Layer.mergeAll(AccountTokens.layer, codexUpstream(config, upstreamBaseUrl))),
      );
    }),
  ).pipe(Command.withDescription("Show how much of its rate limits each account has used"));

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

/**
 * `via accounts`. `status` reads `configPath`; `upstreamBaseUrl` replaces the
 * Codex backend, which only tests do.
 */
export const accounts = (configPath: string, upstreamBaseUrl: string | undefined) =>
  Command.make("accounts").pipe(
    Command.withDescription("Manage the ChatGPT accounts in the pool"),
    Command.withSubcommands([
      add,
      list,
      remove,
      setEnabled("enable", true, "Use an account again"),
      setEnabled("disable", false, "Stop using an account without removing it"),
      labelCommand,
      status(configPath, upstreamBaseUrl),
    ]),
  );
