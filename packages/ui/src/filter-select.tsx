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
import {
  colors,
  durations,
  fonts,
  radii,
  shadows,
  space,
  text,
  fontWeights,
  weights,
} from "./tokens.stylex.ts";

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
  positioner: {
    zIndex: 50,
    outline: "none",
  },
  popup: {
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    width: "min(20rem, var(--available-width))",
    maxHeight: "min(360px, var(--available-height))",
    borderWidth: 1,
    borderStyle: "solid",
    // Invisible, until forced colours draw it as the popup's edge.
    borderColor: "transparent",
    borderRadius: radii.container,
    backgroundColor: colors.surface3,
    boxShadow: shadows.surface3,
    // Portalled to <body>, so it brings its own font.
    fontFamily: fonts.sans,
    outline: "none",
  },
  search: {
    boxSizing: "border-box",
    flexShrink: 0,
    margin: space.s1,
    paddingBlock: space.s2,
    paddingInline: space.s2_5,
    borderWidth: 0,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    borderRadius: 0,
    backgroundColor: "transparent",
    // At least 16px, or iOS zooms the page when it takes focus.
    fontSize: "16px",
    fontFamily: "inherit",
    color: colors.foreground,
    outline: "none",
    "::placeholder": { color: colors.mutedForeground },
  },
  list: {
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
    padding: space.s1,
    paddingTop: 0,
    outline: "none",
  },
  item: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s2,
    minHeight: space.control,
    paddingBlock: space.s2,
    paddingInline: space.s2,
    boxSizing: "border-box",
    borderRadius: radii.item,
    fontSize: text.body,
    color: colors.mutedForeground,
    cursor: "pointer",
    outline: "none",
    transitionProperty: "background-color, color",
    transitionDuration: durations.fast,
  },
  highlighted: {
    color: colors.foreground,
    backgroundColor: colors.hover,
    // Forced colours drop the fill, so an outline follows the row.
    outline: { default: "none", "@media (forced-colors: active)": "2px solid Highlight" },
    outlineOffset: "-2px",
  },
  selected: {
    color: colors.foreground,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
  },
  itemLabel: {
    flexGrow: 1,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  detail: {
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
    color: colors.mutedForeground,
  },
  check: {
    display: "flex",
    flexShrink: 0,
    width: "14px",
    color: colors.foreground,
  },
  empty: {
    paddingBlock: space.s3,
    paddingInline: space.s2,
    fontSize: text.body,
    color: colors.mutedForeground,
    ":empty": { display: "none" },
  },
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
            {...stylex.props(styles.positioner)}
          >
            <BaseCombobox.Popup aria-label={label} {...stylex.props(styles.popup)}>
              <BaseCombobox.Input
                placeholder={`Search ${label.toLowerCase()}s`}
                aria-label={`Search ${label.toLowerCase()}s`}
                {...stylex.props(styles.search)}
              />
              <BaseCombobox.Empty {...stylex.props(styles.empty)}>No matches</BaseCombobox.Empty>
              <BaseCombobox.List {...stylex.props(styles.list)}>
                {(option: FilterOption) => (
                  <BaseCombobox.Item
                    key={option.value}
                    value={option}
                    className={(state) =>
                      stylex.props(
                        styles.item,
                        state.highlighted && styles.highlighted,
                        state.selected && styles.selected,
                      ).className ?? ""
                    }
                  >
                    <span {...stylex.props(styles.check)}>
                      <BaseCombobox.ItemIndicator>
                        <CheckIcon size={14} />
                      </BaseCombobox.ItemIndicator>
                    </span>
                    <span {...stylex.props(styles.itemLabel)}>{option.label}</span>
                    {option.detail !== undefined && (
                      <span {...stylex.props(styles.detail)}>{option.detail}</span>
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
