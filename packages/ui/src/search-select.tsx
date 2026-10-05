/**
 * SearchSelect: a choice of one from options in labelled groups, such as
 * models by provider. Its trigger shows what it is given; a popup searches the
 * options by label and keywords and lists them under their groups, hiding a
 * group that no option of matches. An option can carry a detail, and a
 * disabled one says with it why it can't be picked. With `value` null it is an
 * "add" picker: every pick calls back and the trigger stays as it is.
 */
import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { Button } from "./button.tsx";
import { comboboxStyles } from "./combobox-styles.ts";
import { CheckIcon, ChevronDownIcon } from "./icons.tsx";
import { colors, fontWeights, space, text, weights } from "./tokens.stylex.ts";

const styles = stylex.create({
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  group: {
    display: "flex",
    flexDirection: "column",
    paddingBottom: space.s1,
  },
  groupLabel: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    paddingTop: space.s2,
    paddingBottom: space.s1,
    paddingInline: space.s2,
    fontSize: text.caption,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.mutedForeground,
    userSelect: "none",
  },
  groupIcon: {
    display: "flex",
    flexShrink: 0,
  },
  disabled: { cursor: "not-allowed" },
  // The label fades; the detail beside it, which says why, stays readable.
  disabledLabel: { opacity: 0.6 },
});

/** One choice: what it picks, how it reads, a detail, and other words that find it. */
interface SearchSelectOption {
  readonly value: string;
  readonly label: string;
  /** Muted beside the label; on a disabled option, why it can't be picked. */
  readonly detail?: string;
  /** Searched as well as the label: "moonshot" finds "kimi-k3". */
  readonly keywords?: ReadonlyArray<string>;
  readonly disabled?: boolean;
}

interface SearchSelectGroup {
  /** Shown above the group's options, and names it for assistive tech. */
  readonly label: string;
  readonly icon?: ReactNode;
  readonly options: ReadonlyArray<SearchSelectOption>;
}

interface SearchSelectProps {
  /** Names the trigger, the popup and its search: "Model". */
  readonly label: string;
  readonly groups: ReadonlyArray<SearchSelectGroup>;
  /** The chosen option's value, or null for none, as for an "add" picker. */
  readonly value: string | null;
  readonly onValueChange: (value: string) => void;
  /** What the trigger shows. Include the label's words, so what is seen is what is heard. */
  readonly trigger: ReactNode;
  readonly placeholder?: string;
  readonly emptyText?: string;
  /** The id of an error a form shows for this choice: the trigger is marked invalid, and described by it. */
  readonly error?: string | undefined;
}

const matches = (option: SearchSelectOption, query: string) => {
  const needle = query.toLocaleLowerCase();

  return [option.label, ...(option.keywords ?? [])].some((word) =>
    word.toLocaleLowerCase().includes(needle),
  );
};

export function SearchSelect({
  label,
  groups,
  value,
  onValueChange,
  trigger,
  placeholder = "Search",
  emptyText = "No matches",
  error,
}: SearchSelectProps) {
  const items = groups.map((group) => ({ ...group, items: group.options }));

  const chosen =
    value === null
      ? null
      : (groups.flatMap((group) => group.options).find((option) => option.value === value) ?? null);

  return (
    <BaseCombobox.Root
      items={items}
      value={chosen}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next.value);
      }}
      filter={matches}
      itemToStringLabel={(option) => option.label}
      isItemEqualToValue={(option, other) => option.value === other.value}
    >
      <BaseCombobox.Trigger
        aria-label={chosen === null ? label : `${label}: ${chosen.label}`}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error}
        render={<Button variant="secondary" size="compact" />}
      >
        <span {...stylex.props(styles.trigger)}>{trigger}</span>
        <ChevronDownIcon size={14} />
      </BaseCombobox.Trigger>
      <BaseCombobox.Portal>
        <BaseCombobox.Positioner
          sideOffset={6}
          align="start"
          {...stylex.props(comboboxStyles.positioner)}
        >
          <BaseCombobox.Popup aria-label={label} {...stylex.props(comboboxStyles.popup)}>
            <BaseCombobox.Input
              placeholder={placeholder}
              aria-label={label}
              {...stylex.props(comboboxStyles.search)}
            />
            <BaseCombobox.Empty {...stylex.props(comboboxStyles.empty)}>
              {emptyText}
            </BaseCombobox.Empty>
            <BaseCombobox.List {...stylex.props(comboboxStyles.list)}>
              {(group: (typeof items)[number]) => (
                <BaseCombobox.Group
                  key={group.label}
                  items={group.items}
                  {...stylex.props(styles.group)}
                >
                  <BaseCombobox.GroupLabel {...stylex.props(styles.groupLabel)}>
                    {group.icon !== undefined && (
                      <span aria-hidden="true" {...stylex.props(styles.groupIcon)}>
                        {group.icon}
                      </span>
                    )}
                    {group.label}
                  </BaseCombobox.GroupLabel>
                  <BaseCombobox.Collection>
                    {(option: SearchSelectOption) => (
                      <BaseCombobox.Item
                        key={option.value}
                        value={option}
                        disabled={option.disabled}
                        className={(state) =>
                          stylex.props(
                            comboboxStyles.item,
                            state.highlighted && !state.disabled && comboboxStyles.highlighted,
                            state.selected && comboboxStyles.selected,
                            state.disabled && styles.disabled,
                          ).className ?? ""
                        }
                      >
                        <span {...stylex.props(comboboxStyles.check)}>
                          <BaseCombobox.ItemIndicator>
                            <CheckIcon size={14} />
                          </BaseCombobox.ItemIndicator>
                        </span>
                        <span
                          {...stylex.props(
                            comboboxStyles.itemLabel,
                            option.disabled === true && styles.disabledLabel,
                          )}
                        >
                          {option.label}
                        </span>
                        {option.detail !== undefined && (
                          <span {...stylex.props(comboboxStyles.detail)}>{option.detail}</span>
                        )}
                      </BaseCombobox.Item>
                    )}
                  </BaseCombobox.Collection>
                </BaseCombobox.Group>
              )}
            </BaseCombobox.List>
          </BaseCombobox.Popup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    </BaseCombobox.Root>
  );
}
