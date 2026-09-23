import { homedir } from "node:os";
import { join } from "node:path";

export type Paths = {
  home: string;
  config: string;
  keys: string;
  authDir: string;
  state: string;
};

export function resolvePaths(env: Record<string, string | undefined> = process.env): Paths {
  const home = env.VIA_HOME ?? join(homedir(), ".config", "via");
  return {
    home,
    config: join(home, "config.yaml"),
    keys: join(home, "keys.json"),
    authDir: join(home, "auth"),
    state: join(home, "state.json"),
  };
}
