/**
 * FilterSelect: one facet of a filter bar, such as the model a page shows.
 * Its trigger names the facet, and what is chosen once something is; a popup
 * searches the options and lists each with a detail, such as a count. A
 * remove button beside the trigger clears the choice. Base UI's combobox gives
 * the trigger its role, the list its keyboard, and the search its filtering.
 */
import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import * as stylex from "@stylexjs/stylex";
import { Button } from "./button.tsx";
import { CheckIcon, ChevronDownIcon, XIcon } from "./icons.tsx";
import { comboboxStyles } from "./combobox-styles.ts";
import { colors } from "./tokens.stylex.ts";

const styles = stylex.create({
  facet: {
    display: "inline-flex",
    alignItems: "center",
    maxWidth: "100%",
    minWidth: 0,
  },
  triggerLabel: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  facetName: { color: colors.mutedForeground },
});

/** One choice of a facet: what it filters on, how it reads, and a detail such as a count. */
export interface FilterOption {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
}

export interface FilterSelectProps {
  /** The facet, which names the trigger: "Model". */
  readonly label: string;
  readonly options: ReadonlyArray<FilterOption>;
  /** The chosen option's value, or null for none. */
  readonly value: string | null;
  readonly onValueChange: (value: string | null) => void;
  /** A value chosen but not among the options, as for a link to a range without it, reads as this. */
  readonly fallbackLabel?: (value: string) => string;
}

export function FilterSelect({
  label,
  options,
  value,
  onValueChange,
  fallbackLabel = (chosen) => chosen,
}: FilterSelectProps) {
  const chosen =
    value === null
      ? null
      : (options.find((option) => option.value === value) ?? {
          value,
          label: fallbackLabel(value),
        });

  const name = chosen === null ? label : `${label}: ${chosen.label}`;

  return (
    <span {...stylex.props(styles.facet)}>
      <BaseCombobox.Root
        items={options}
        value={chosen}
        onValueChange={(next) => onValueChange(next?.value ?? null)}
        itemToStringLabel={(option) => option.label}
        isItemEqualToValue={(option, other) => option.value === other.value}
      >
        <BaseCombobox.Trigger
          aria-label={name}
          render={<Button variant="secondary" size="compact" />}
        >
          <span {...stylex.props(styles.triggerLabel)}>
            {chosen === null ? (
              label
            ) : (
              <>
                <span {...stylex.props(styles.facetName)}>{label}: </span>
                {chosen.label}
              </>
            )}
          </span>
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
                placeholder={`Search ${label.toLowerCase()}s`}
                aria-label={`Search ${label.toLowerCase()}s`}
                {...stylex.props(comboboxStyles.search)}
              />
              <BaseCombobox.Empty {...stylex.props(comboboxStyles.empty)}>
                No matches
              </BaseCombobox.Empty>
              <BaseCombobox.List {...stylex.props(comboboxStyles.list)}>
                {(option: FilterOption) => (
                  <BaseCombobox.Item
                    key={option.value}
                    value={option}
                    className={(state) =>
                      stylex.props(
                        comboboxStyles.item,
                        state.highlighted && comboboxStyles.highlighted,
                        state.selected && comboboxStyles.selected,
                      ).className ?? ""
                    }
                  >
                    <span {...stylex.props(comboboxStyles.check)}>
                      <BaseCombobox.ItemIndicator>
                        <CheckIcon size={14} />
                      </BaseCombobox.ItemIndicator>
                    </span>
                    <span {...stylex.props(comboboxStyles.itemLabel)}>{option.label}</span>
                    {option.detail !== undefined && (
                      <span {...stylex.props(comboboxStyles.detail)}>{option.detail}</span>
                    )}
                  </BaseCombobox.Item>
                )}
              </BaseCombobox.List>
            </BaseCombobox.Popup>
          </BaseCombobox.Positioner>
        </BaseCombobox.Portal>
      </BaseCombobox.Root>
      {chosen !== null && (
        <Button
          variant="ghost"
          size="icon-compact"
          aria-label={`Remove ${label} filter`}
          onClick={() => onValueChange(null)}
        >
          <XIcon size={14} />
        </Button>
      )}
    </span>
  );
}
