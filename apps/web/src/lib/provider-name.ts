/** Providers whose name reads differently from their id; every other one is shown by its id. */
const NAMES: ReadonlyMap<string, string> = new Map([
  ["codex", "Codex"],
  ["opencode-go", "OpenCode Go"],
  ["ollama", "Ollama"],
]);

/** The name to show for the provider with id `id`, such as a model's `<provider>/` prefix. */
export const providerName = (id: string) => NAMES.get(id) ?? id;
