import { join } from "node:path";

type Paths = {
  home: string;
  config: string;
  keys: string;
  authDir: string;
  state: string;
  opencodeGo: string;
  ollama: string;
  openrouter: string;
  fallbacks: string;
  usageDb: string;
};

/**
 * Where via keeps its files: `VIA_HOME` from `env` when set, else `.config/via`
 * under `userHome`. The caller reads both from the environment.
 */
export function resolvePaths(
  env: { readonly VIA_HOME?: string | undefined },
  userHome: string,
): Paths {
  // An empty VIA_HOME, as `VIA_HOME=` in a compose file sets it, would put via's files,
  // tokens included, in whatever directory it started in.
  const home = env.VIA_HOME || join(userHome, ".config", "via");

  return {
    home,
    config: join(home, "config.yaml"),
    keys: join(home, "keys.json"),
    authDir: join(home, "auth"),
    state: join(home, "state.json"),
    opencodeGo: join(home, "opencode-go.json"),
    ollama: join(home, "ollama.json"),
    openrouter: join(home, "openrouter.json"),
    fallbacks: join(home, "fallbacks.json"),
    usageDb: join(home, "usage.db"),
  };
}
