import { accountUsage } from "@via/account-pool";
import { type Account, AccountStore, AccountTokens, CodexAuth } from "@via/codex-auth";
import { CodexUpstream } from "@via/codex-upstream";
import { loadConfig, type ProviderConfig } from "@via/config";
import type { UsageWindow } from "@via/pool";
import {
  maskKey,
  type OpencodeGoAccount,
  OpencodeGoAccounts,
  Providers,
  providerState,
} from "@via/providers";
import type { ProviderState } from "@via/providers/schemas";
import { Clock, Console, Effect, Layer, Record, Redacted } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { apiKeys } from "./api-keys.ts";
import { readApiKey } from "./read-key.ts";
import { localTime } from "./time.ts";
import { version } from "./version.ts";

const accountArg = Argument.String("account").pipe(
  Argument.withDescription("Account id, label or email"),
);

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

/**
 * Providers with only OpenCode Go's config, which never fails: another
 * provider's can't keep its accounts from being added or shown.
 */
const opencodeGoProviders = (providers: Record<string, ProviderConfig>) =>
  Providers.layer({
    providers: Record.filter(providers, (_, name) => name === "opencode-go"),
    apiKeys: {},
    version,
  });

/** Stores an OpenCode Go API key as an account, once OpenCode Go takes it, as the web UI does. */
const addOpencodeGo = (configPath: string) =>
  Effect.gen(function* () {
    const apiKey = yield* readApiKey("OpenCode Go");
    const config = yield* loadConfig(configPath);
    yield* Effect.flatMap(Providers, (providers) => providers.verify(apiKey)).pipe(
      Effect.provide(opencodeGoProviders(config.providers)),
    );
    const saved = yield* (yield* OpencodeGoAccounts).add(apiKey);
    yield* Console.log(`Added OpenCode Go key ${maskKey(apiKey)} as "${saved.label}".`);
  });

const add = (configPath: string) =>
  Command.make(
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

        return yield* addOpencodeGo(configPath);
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

/**
 * Each configured provider with its own key, all asked at once whether it can
 * be used: a line saying it is available, or why not.
 */
const providerSections = Effect.flatMap(Providers, ({ names, check }) =>
  Effect.flatMap(names, (all) =>
    Effect.forEach(
      all,
      (name) =>
        check(name).pipe(
          Effect.as("available"),
          Effect.catchTags({
            ProviderKeyRefusedError: ({ status }) => Effect.succeed(`key refused (HTTP ${status})`),
            ProviderUnreachableError: ({ reason }) => Effect.succeed(`unavailable: ${reason}`),
          }),
          Effect.map((state) => ({ line: `${name}  provider  ${state}`, rows: [] })),
        ),
      { concurrency: "unbounded" },
    ),
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

const unreadableUsage = "  ChatGPT's usage answer could not be read";

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
      // One with a response came from an answer, such as a page, that isn't JSON.
      HttpClientError: (error) =>
        Effect.succeed([
          error.response === undefined ? "  Could not reach ChatGPT for usage" : unreadableUsage,
        ]),
      SchemaError: () => Effect.succeed([unreadableUsage]),
    }),
  );

  for (const line of lines) yield* Console.log(line);
});

/**
 * OpenCode Go's key in its deprecated environment variable, as an account shown
 * by the variable's name, unless one has it. `via serve` stores it; `status`,
 * which only reads, leaves that to it.
 */
const fromEnvironment = (
  providers: Record<string, ProviderConfig>,
  keys: Readonly<Record<string, Redacted.Redacted<string>>>,
  stored: ReadonlyArray<OpencodeGoAccount>,
): ReadonlyArray<OpencodeGoAccount> => {
  const apiKey = keys["opencode-go"];
  const variable = providers["opencode-go"]?.apiKeyEnv;

  if (apiKey === undefined || variable === undefined) return [];

  if (stored.some((a) => Redacted.value(a.apiKey) === Redacted.value(apiKey))) return [];

  return [
    { id: variable, label: `OpenCode Go (from ${variable})`, apiKey, enabled: true, createdAt: "" },
  ];
};

/** A provider that can't be set up, e.g. for a missing API key, says so in its place. */
const say = (error: { readonly message: string }) =>
  Effect.succeed([{ line: error.message, rows: [] }]);

const status = (configPath: string, upstreamBaseUrl: string | undefined) =>
  Command.make("status", {}, () =>
    Effect.gen(function* () {
      const config = yield* loadConfig(configPath);
      const keys = yield* apiKeys(config.providers);
      const accounts = yield* (yield* AccountStore).list;
      const stored = yield* (yield* OpencodeGoAccounts).list;
      const opencodeGo = [...stored, ...fromEnvironment(config.providers, keys, stored)];

      const providers = yield* providerSections.pipe(
        Effect.provide(Providers.layer({ providers: config.providers, apiKeys: keys, version })),
        Effect.catchTags({ MissingApiKeyError: say, UnknownProviderError: say }),
      );

      // Asked first, so the ChatGPT accounts' windows can line up with OpenCode Go's longer names.
      const opencodeGoAccounts = yield* opencodeGoSections(opencodeGo).pipe(
        Effect.provide(opencodeGoProviders(config.providers)),
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
 * `via accounts`. `add` and `status` read `configPath`; `upstreamBaseUrl` replaces the
 * Codex backend, which only tests do.
 */
export const accounts = (configPath: string, upstreamBaseUrl: string | undefined) =>
  Command.make("accounts").pipe(
    Command.withDescription("Manage the ChatGPT and OpenCode Go accounts in the pool"),
    Command.withSubcommands([
      add(configPath),
      list,
      remove,
      setEnabled("enable", true, "Use an account again"),
      setEnabled("disable", false, "Stop using an account without removing it"),
      labelCommand,
      status(configPath, upstreamBaseUrl),
    ]),
  );
