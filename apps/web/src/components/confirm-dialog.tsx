import { useMutation } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogContent,
  Button,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useToast,
} from "@via/ui";
import { type ReactNode, useRef } from "react";
import { useMask } from "../lib/privacy.ts";
import { TrashIcon } from "./icons.tsx";
import { usePageHeading } from "./page.tsx";

/**
 * Asks before something that can't be taken back, such as removing an account
 * or revoking a key, then does it with `confirm`. While it runs, the dialog
 * can't be closed; a failure keeps it open and says why in a toast. Once done,
 * its trigger went with what it removed, so focus goes to the page's heading.
 */
export function ConfirmDialog({
  open,
  onClose,
  onClosed,
  title,
  description,
  confirmLabel,
  confirm,
  onConfirmed,
  done,
  failed,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onClosed: () => void;
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly confirm: () => Promise<void>;
  /** Once it's done, such as fetching the list it changed again. */
  readonly onConfirmed: () => void;
  /** The toast once it's done. */
  readonly done: { readonly title: string; readonly description: string };
  /** The failure toast's title, naming the action: "Couldn't remove". */
  readonly failed: string;
}) {
  const toast = useToast();
  const mask = useMask();
  const heading = usePageHeading();
  // Read as the dialog closes, which can be before the success renders.
  const confirmed = useRef(false);

  const mutation = useMutation({
    mutationFn: confirm,
    onSuccess: () => {
      confirmed.current = true;
      onConfirmed();
      toast.add(done);
      onClose();
    },
    onError: (error) =>
      toast.add({ type: "error", title: failed, description: mask.key(error.message) }),
  });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => !next && !mutation.isPending && onClose()}
      onOpenChangeComplete={(next) => !next && onClosed()}
    >
      <AlertDialogContent finalFocus={() => (confirmed.current ? heading.current : true)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose
            disabled={mutation.isPending}
            render={<Button variant="tertiary">Cancel</Button>}
          />
          <Button
            variant="destructive"
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            <TrashIcon size={15} />
            {confirmLabel}
          </Button>
        </DialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
