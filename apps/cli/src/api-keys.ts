import type { ProviderConfig } from "@via/config";
import { OpencodeGoAccounts } from "@via/providers";
import { Config, Effect, Option, Record, type Redacted } from "effect";

/**
 * Each provider's API key by provider name, read from the environment variable
 * its config names. A provider whose variable is not set is left out, and the
 * providers layer says so.
 */
export const apiKeys = (providers: Record<string, ProviderConfig>) =>
  Config.all(
    Record.map(providers, ({ apiKeyEnv }) => Config.option(Config.Redacted(apiKeyEnv))),
  ).pipe(Config.map(Record.getSomes));

/**
 * Stores OpenCode Go's key from `keys`, read from its deprecated environment
 * variable, as an account, unless one already has it. Some with the variable's
 * name while it is set, so serve can say to remove it.
 */
export const importOpencodeGoKey = (
  providers: Record<string, ProviderConfig>,
  keys: Readonly<Record<string, Redacted.Redacted<string>>>,
) =>
  Effect.gen(function* () {
    const key = keys["opencode-go"];
    const variable = providers["opencode-go"]?.apiKeyEnv;

    if (key === undefined || variable === undefined) return Option.none<string>();
    yield* (yield* OpencodeGoAccounts).importKey(key);

    return Option.some(variable);
  });
