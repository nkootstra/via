import type { ProviderConfig } from "@via/config";
import { Config, Record } from "effect";

/**
 * Each provider's API key by provider name, read from the environment variable
 * its config names. A provider whose variable is not set is left out, and the
 * providers layer says so.
 */
export const apiKeys = (providers: Record<string, ProviderConfig>) =>
  Config.all(
    Record.map(providers, ({ apiKeyEnv }) => Config.option(Config.Redacted(apiKeyEnv))),
  ).pipe(Config.map(Record.getSomes));
