import * as stylex from "@stylexjs/stylex";
import { useMutation } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  useToast,
} from "@via/ui";
import { useState } from "react";

const styles = stylex.create({
  form: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
  },
});

/**
 * Asks for a new name for `name`, a `thing` ("Account", "Key"), in a `field`
 * ("Label", "Name"). `rename` saves it, resolving to why via refused the name
 * if it did. That, an empty field and a failure show in the form, which stays
 * open to try again; the same name just closes it. `onRenamed` follows a
 * rename that took. It stays mounted while it closes, so it animates out.
 */
export function RenameDialog({
  open,
  onClose,
  onClosed,
  thing,
  name,
  field,
  description,
  rename,
  onRenamed,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Once it has animated out, when it can go. */
  readonly onClosed: () => void;
  readonly thing: string;
  readonly name: string;
  readonly field: string;
  readonly description: string;
  readonly rename: (to: string) => Promise<string | undefined>;
  readonly onRenamed: () => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState(name);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const to = value.trim();

  const mutation = useMutation({
    mutationFn: () => rename(to),
    onSuccess: (refused) => {
      if (refused !== undefined) return setProblem(refused);

      onRenamed();
      toast.add({ title: `${thing} renamed`, description: `It's now called ${to}.` });
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      onOpenChangeComplete={(next) => !next && onClosed()}
    >
      <DialogContent>
        <form
          {...stylex.props(styles.form)}
          onSubmit={(event) => {
            event.preventDefault();

            if (to === "") return setProblem(`Enter a ${field.toLowerCase()}.`);

            if (to === name) return onClose();
            mutation.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename {name}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <Field label={field} error={problem ?? mutation.error?.message}>
            <Input
              value={value}
              onValueChange={(next) => {
                setValue(next);
                setProblem(undefined);
                mutation.reset();
              }}
              name={field.toLowerCase()}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="tertiary">Cancel</Button>} />
            <Button type="submit" loading={mutation.isPending}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
