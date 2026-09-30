import { accountUsage } from "@via/account-pool";
import { type Account, AccountStore, AccountTokens, CodexAuth } from "@via/codex-auth";
import { CodexUpstream } from "@via/codex-upstream";
import { loadConfig } from "@via/config";
import type { UsageWindow } from "@via/pool";
import {
  maskKey,
  type OpencodeGoAccount,
  OpencodeGoAccounts,
  Providers,
  providerState,
} from "@via/providers";
import type { ProviderState } from "@via/providers/schemas";
import {
  Clock,
  Console,
  Effect,
  Layer,
  Record,
  Redacted,
  Schema,
  Stdio,
  Stream,
  String as Str,
} from "effect";
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli";
import { apiKeys, importOpencodeGoKey } from "./api-keys.ts";
import { localTime } from "./time.ts";
import { version } from "./version.ts";

const accountArg = Argument.String("account").pipe(
  Argument.withDescription("Account id, label or email"),
);

class MissingApiKeyError extends Schema.TaggedError<MissingApiKeyError>()(
  "MissingApiKeyError",
  {},
) {
  override get message() {
    return "No OpenCode Go API key was given";
  }
}

/**
 * An OpenCode Go API key: typed in, hidden, at a terminal, else read from
 * standard input, so a script can pipe it in. Never an argument, which would
 * end up in the shell's history and the process list.
 */
const readApiKey = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;

  const key = (yield* stdio.stdinIsTerminal)
    ? Redacted.value(yield* Prompt.run(Prompt.Password({ message: "OpenCode Go API key" })))
    : yield* stdio.stdin.pipe(Stream.decodeText, Stream.mkString);

  const trimmed = Str.trim(key);

  if (trimmed === "") return yield* new MissingApiKeyError();

  return Redacted.make(trimmed);
});

/** Logs in to a ChatGPT account with a device code. */
const addCodex = Effect.gen(function* () {
  const auth = yield* CodexAuth;
  const code = yield* auth.requestDeviceCode;
  yield* Console.log(`Open ${code.verificationUrl} and enter the code ${code.userCode}`);
  yield* Console.log("Waiting for approval...");

  const { account, created } = yield* (yield* AccountStore).save(
    yield* auth.awaitDeviceTokens(code),
  );

  const { email, plan, label } = account;

  yield* Console.log(
    created
      ? `Added ${email} (${plan}) as "${label}".`
      : `Signed "${label}" in again: ${email} (${plan}) was already in the pool, so it got fresh tokens.`,
  );
});

/** Stores an OpenCode Go API key as an account. */
const addOpencodeGo = Effect.gen(function* () {
  const apiKey = yield* readApiKey;
  const saved = yield* (yield* OpencodeGoAccounts).add(apiKey);
  yield* Console.log(`Added OpenCode Go key ${maskKey(apiKey)} as "${saved.label}".`);
});

const add = Command.make(
  "add",
  {
    provider: Flag.Literals("provider", ["codex", "opencode-go"]).pipe(
      Flag.withDescription(
        "codex logs in to a ChatGPT account; opencode-go asks for an OpenCode Go API key",
      ),
      Flag.withDefault("codex"),
    ),
  },
  ({ provider }) =>
    Effect.gen(function* () {
      if (provider === "codex") return yield* addCodex;

      return yield* addOpencodeGo;
    }),
).pipe(
  Command.withDescription(
    "Log in to a ChatGPT account with a device code, or add an OpenCode Go API key",
  ),
);

const noAccounts = "No accounts. Add one with `via accounts add`.";

const describe = (a: Account) =>
  `${a.id}  ${a.label}  ${a.email}  ${a.plan}  ${a.enabled ? "enabled" : "disabled"}`;

/** An OpenCode Go account as a line shows it, its key masked. */
const describeGo = (a: OpencodeGoAccount) =>
  `${a.id}  ${a.label}  opencode-go  ${maskKey(a.apiKey)}  ${a.enabled ? "enabled" : "disabled"}`;

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const accounts = yield* (yield* AccountStore).list;
    const opencodeGo = yield* (yield* OpencodeGoAccounts).list;

    if (accounts.length === 0 && opencodeGo.length === 0) return yield* Console.log(noAccounts);

    for (const a of accounts) yield* Console.log(describe(a));

    for (const a of opencodeGo) yield* Console.log(describeGo(a));
  }),
).pipe(
  Command.withDescription(
    "List accounts, ChatGPT's then OpenCode Go's, in the order they are used",
  ),
);

/** A usage window as a line shows it. */
type Row = { readonly name: string; readonly usedPercent: number; readonly resetsAt: Date };

/**
 * A window as `5h    12% used  resets 2023-11-14 23:13`, its name padded to `width`
 * so that every account's and provider's windows line up.
 */
const usageLine = (width: number, { name, usedPercent, resetsAt }: Row) =>
  `  ${name.padEnd(width)} ${String(usedPercent).padStart(3)}% used  resets ${localTime(resetsAt)}`;

const accountRow = ({ windowMinutes, usedPercent, resetsAt }: UsageWindow): Row => ({
  name: windowMinutes % 1440 === 0 ? `${windowMinutes / 1440}d` : `${windowMinutes / 60}h`,
  usedPercent,
  resetsAt: new Date(resetsAt),
});

/** A provider's state as its line ends: `available`, or why it isn't. */
const describeState = (state: ProviderState) => {
  switch (state.status) {
    case "available":
      return "available";
    case "exhausted":
      return `exhausted until ${localTime(new Date(state.until))} (${state.window})`;
    case "unavailable":
      return `unavailable: ${state.reason}`;
  }
};

/** Each configured provider with its own key, a line saying it is available. */
const providerSections = Effect.flatMap(Providers, ({ names }) =>
  Effect.map(names, (all) =>
    all.map((name) => ({ line: `${name}  provider  available`, rows: [] })),
  ),
);

/**
 * Each OpenCode Go account, like a ChatGPT one: a line with its state, as the
 * admin API's pool tells it, and the windows of its usage.
 */
const opencodeGoSections = (accounts: ReadonlyArray<OpencodeGoAccount>) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const now = yield* Clock.currentTimeMillis;

    // One account at a time, so this never bursts requests at OpenCode Go.
    return yield* Effect.forEach(accounts, (account) =>
      Effect.map(providers.usage(account.apiKey), (usage) => ({
        line: `${describeGo(account)}  ${describeState(providerState(usage, now))}`,
        rows:
          "error" in usage
            ? []
            : usage.windows.map(({ window, usedPercent, resetsAt }) => ({
                name: window,
                usedPercent,
                resetsAt: new Date(resetsAt),
              })),
      })),
    );
  });

/** Why an account's usage is missing, in place of its windows. */
const why = (error: { readonly message: string }) => Effect.succeed([`  ${error.message}`]);

const showUsage = Effect.fnUntraced(function* (width: number, account: Account) {
  yield* Console.log(describe(account));

  // `status` runs apart from `via serve`, so a failed refresh is only reported here.
  const lines = yield* accountUsage(account).pipe(
    Effect.map((windows) => windows.map((window) => usageLine(width, accountRow(window)))),
    Effect.catchTags({
      RefreshRejectedError: why,
      UsageUnavailableError: why,
      AuthRequestError: why,
      // One account's usage that can't be fetched or read mustn't hide the others'.
      HttpClientError: () => Effect.succeed(["  Could not reach ChatGPT for usage"]),
      SchemaError: () => Effect.succeed(["  ChatGPT's usage answer could not be read"]),
    }),
  );

  for (const line of lines) yield* Console.log(line);
});

/** A provider that can't be set up, e.g. for a missing API key, says so in its place. */
const say = (error: { readonly message: string }) =>
  Effect.succeed([{ line: error.message, rows: [] }]);

const status = (configPath: string, upstreamBaseUrl: string | undefined) =>
  Command.make("status", {}, () =>
    Effect.gen(function* () {
      const config = yield* loadConfig(configPath);
      const keys = yield* apiKeys(config.providers);
      yield* importOpencodeGoKey(config.providers, keys);
      const accounts = yield* (yield* AccountStore).list;
      const opencodeGo = yield* (yield* OpencodeGoAccounts).list;

      const providers = yield* providerSections.pipe(
        Effect.provide(Providers.layer({ providers: config.providers, apiKeys: keys, version })),
        Effect.catchTags({ MissingApiKeyError: say, UnknownProviderError: say }),
      );

      // Asked first, so the ChatGPT accounts' windows can line up with OpenCode Go's longer names.
      const opencodeGoAccounts = yield* opencodeGoSections(opencodeGo).pipe(
        // Only OpenCode Go's own config, which never fails: another provider's can't hide its accounts.
        Effect.provide(
          Providers.layer({
            providers: Record.filter(config.providers, (_, name) => name === "opencode-go"),
            apiKeys: {},
            version,
          }),
        ),
      );

      const width = Math.max(
        4,
        ...opencodeGoAccounts.flatMap(({ rows }) => rows.map(({ name }) => name.length)),
      );

      if (accounts.length === 0 && opencodeGo.length === 0) yield* Console.log(noAccounts);
      yield* Effect.forEach(accounts, (account) => showUsage(width, account), {
        discard: true,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            AccountTokens.layer,
            CodexUpstream.layer({ baseUrl: upstreamBaseUrl, cloak: config.codex.cloak, version }),
          ),
        ),
      );

      for (const { line, rows } of [...opencodeGoAccounts, ...providers]) {
        yield* Console.log(line);

        for (const row of rows) yield* Console.log(usageLine(width, row));
      }
    }),
  ).pipe(
    Command.withDescription("Show how much of its rate limits each account and provider has used"),
  );

/**
 * Changes a ChatGPT account as `codex` does, else, when it finds none, an OpenCode
 * Go account as `opencodeGo` does; when that finds none either, fails as `codex` did.
 */
const change = (
  codex: (store: AccountStore["Service"]) => ReturnType<AccountStore["Service"]["remove"]>,
  opencodeGo: (
    store: OpencodeGoAccounts["Service"],
  ) => ReturnType<OpencodeGoAccounts["Service"]["remove"]>,
) =>
  Effect.flatMap(AccountStore, codex).pipe(
    Effect.catchTag("AccountNotFoundError", (notFound) =>
      Effect.flatMap(OpencodeGoAccounts, opencodeGo).pipe(
        Effect.catchTag("OpencodeGoAccountNotFoundError", () => Effect.fail(notFound)),
      ),
    ),
  );

const remove = Command.make("remove", { account: accountArg }, ({ account }) =>
  Effect.gen(function* () {
    yield* change(
      (store) => store.remove(account),
      (store) => store.remove(account),
    );
    yield* Console.log(`Removed "${account}".`);
  }),
).pipe(Command.withDescription("Forget an account and its tokens or key"));

const setEnabled = (name: "enable" | "disable", enabled: boolean, description: string) =>
  Command.make(name, { account: accountArg }, ({ account }) =>
    Effect.gen(function* () {
      yield* change(
        (store) => store.setEnabled(account, enabled),
        (store) => store.setEnabled(account, enabled),
      );
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
      yield* change(
        (store) => store.setLabel(account, label),
        (store) => store.setLabel(account, label),
      );
      yield* Console.log(`Labelled "${account}" as "${label}".`);
    }),
).pipe(Command.withDescription("Rename an account"));

/**
 * `via accounts`. `status` reads `configPath`; `upstreamBaseUrl` replaces the
 * Codex backend, which only tests do.
 */
export const accounts = (configPath: string, upstreamBaseUrl: string | undefined) =>
  Command.make("accounts").pipe(
    Command.withDescription("Manage the ChatGPT and OpenCode Go accounts in the pool"),
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
