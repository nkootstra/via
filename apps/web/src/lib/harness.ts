/** The coding agent ("harness") a conversation came from, named as its maker names it. */
import { Option } from "effect";

/** Harnesses by the product their User-Agent starts with, lower-cased. */
const PRODUCTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^opencode$/, "OpenCode"],
  // Codex names its builds codex_cli_rs, codex_exec, codex_vscode and so on.
  [/^codex(?:[_-]|$)/, "Codex"],
  [/^claude-(?:cli|code)$/, "Claude Code"],
  [/^aider$/, "Aider"],
  [/^kilo[ -]?code$/, "Kilo Code"],
  [/^roo[ -]?code$/, "Roo Code"],
];

/** Harnesses by the header or body field their conversation's id came from. */
const SOURCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^x-opencode-/, "OpenCode"],
  [/^x-claude-code-/, "Claude Code"],
  [/^(?:thread-id|conversation_id|x-codex-|body\.client_metadata\.thread_id$)/, "Codex"],
  [/^x-kilocode-/, "Kilo Code"],
];

const named = (table: ReadonlyArray<readonly [RegExp, string]>, value: string) =>
  Option.fromNullishOr(table.find(([pattern]) => pattern.test(value))?.[1]);

/**
 * The harness's name and version from `client`, the User-Agent's first product
 * (`opencode/1.19.3` → "OpenCode 1.19.3"), or, without one, from the id it
 * sent (`x-claude-code-session-id` → "Claude Code").
 */
export const harnessName = (client: Option.Option<string>, source: string) =>
  Option.match(client, {
    onNone: () => Option.getOrElse(named(SOURCES, source), () => "Unknown client"),
    onSome: (product) => {
      const [name = product, version] = product.split("/");
      const shown = Option.getOrElse(named(PRODUCTS, name.toLowerCase()), () => name);

      return version === undefined ? shown : `${shown} ${version}`;
    },
  });
