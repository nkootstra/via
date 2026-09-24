import { CodexUpstream } from "@via/codex-upstream";
import type { Config } from "@via/config";

/** The Codex backend as configured; `baseUrl` replaces it, which only tests do. */
export const codexUpstream = (config: Config, baseUrl: string | undefined) =>
  CodexUpstream.layer({
    cloak: config.codex.cloak,
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
