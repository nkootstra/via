import * as stylex from "@stylexjs/stylex";
import { colors, space } from "@via/ui/tokens.stylex";
import { ownerOf, withoutPrefix } from "../lib/model-entries.ts";
import { providerName } from "../lib/provider-name.ts";
import { CodexIcon, ProviderLogo } from "./icons.tsx";

const styles = stylex.create({
  model: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    minWidth: 0,
  },
  logo: {
    display: "flex",
    flexShrink: 0,
    color: colors.mutedForeground,
  },
  modelId: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

/**
 * A model as the pages name it: its provider's logo, which reads out as the
 * provider, then its id without the prefix; the full id on hover.
 */
export function ModelName({ id }: { readonly id: string }) {
  const owner = ownerOf(id);

  return (
    <span title={id} {...stylex.props(styles.model)}>
      <span {...stylex.props(styles.logo)}>
        {owner === "Codex" ? (
          <CodexIcon size={14} label="Codex" />
        ) : (
          <ProviderLogo name={owner} size={14} label={providerName(owner)} />
        )}
      </span>
      <span {...stylex.props(styles.modelId)}>{withoutPrefix(id)}</span>
    </span>
  );
}
