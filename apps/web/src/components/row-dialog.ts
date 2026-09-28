import { useState } from "react";

/** What a row's dialog is handed: its row, whether it is open, and how to close it. */
export interface RowDialogProps<Row> {
  readonly row: Row;
  readonly open: boolean;
  readonly onClose: () => void;
  /** Once it has animated out, when the dialog can go. */
  readonly onClosed: () => void;
}

/**
 * Which of a table's row dialogs is open, and for which row. Closing keeps the
 * row until the dialog has animated out, so it leaves as it came.
 */
export function useRowDialog<Row, Name extends string>() {
  const [shown, setShown] = useState<{
    readonly dialog: Name;
    readonly row: Row;
    readonly open: boolean;
  } | null>(null);

  const show = (dialog: Name, row: Row) => setShown({ dialog, row, open: true });

  const propsFor = (dialog: Name): RowDialogProps<Row> | undefined =>
    shown?.dialog === dialog
      ? {
          row: shown.row,
          open: shown.open,
          onClose: () => setShown((current) => current && { ...current, open: false }),
          onClosed: () => setShown(null),
        }
      : undefined;

  return { show, propsFor };
}
