/**
 * AlertDialog: a Dialog that asks for a decision. Base UI gives it the
 * `alertdialog` role and keeps it open on an outside click; it has no ✕, so
 * the choice is made in its footer. Title, description, footer and close
 * are the Dialog's.
 */
import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { DialogPanel, type DialogContentProps } from "./dialog.tsx";

export const AlertDialog = BaseAlertDialog.Root;

export const AlertDialogTrigger = BaseAlertDialog.Trigger;

export function AlertDialogContent({ size = "sm", finalFocus, children }: DialogContentProps) {
  return (
    <DialogPanel size={size} finalFocus={finalFocus} closeButton={false}>
      {children}
    </DialogPanel>
  );
}
