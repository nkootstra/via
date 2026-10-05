/**
 * The styles a combobox popup shares, between FilterSelect and SearchSelect:
 * the popup, its search, the list and its rows, a row's detail and check, and
 * what it says when nothing matches.
 */
import * as stylex from "@stylexjs/stylex";
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

export const comboboxStyles = stylex.create({
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
