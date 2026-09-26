import { CodexUpstream } from "@via/codex-upstream";
import type { Config } from "@via/config";
import { version } from "./version.ts";

/** The Codex backend as configured; `baseUrl` replaces it, which only tests do. */
export const codexUpstream = (config: Config, baseUrl: string | undefined) =>
  CodexUpstream.layer({
    cloak: config.codex.cloak,
    version,
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
