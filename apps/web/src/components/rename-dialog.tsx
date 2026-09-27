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
 * ("Label", "Name"). `rename` saves it, resolving to why via refused the name,
 * shown by the field, if it did; `onRenamed` follows a rename that took.
 */
export function RenameDialog({
  thing,
  name,
  field,
  description,
  rename,
  onRenamed,
  onClose,
}: {
  readonly thing: string;
  readonly name: string;
  readonly field: string;
  readonly description: string;
  readonly rename: (to: string) => Promise<string | undefined>;
  readonly onRenamed: () => void;
  readonly onClose: () => void;
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
    onError: (error) =>
      toast.add({ type: "error", title: "Couldn't rename", description: error.message }),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          {...stylex.props(styles.form)}
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename {name}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <Field label={field} error={problem}>
            <Input
              value={value}
              onValueChange={(next) => {
                setValue(next);
                setProblem(undefined);
              }}
              required
            />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="tertiary">Cancel</Button>} />
            <Button type="submit" loading={mutation.isPending} disabled={to === "" || to === name}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
