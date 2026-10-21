import { useMutation } from "@tanstack/react-query";
import { useToast } from "@via/ui";

/**
 * Copies text to the clipboard and says so in a toast, `copied` its title. A
 * browser without a clipboard, as over plain http, refuses, and the toast says that.
 */
export function useCopyText() {
  const toast = useToast();

  return useMutation({
    mutationFn: ({ text }: { readonly text: string; readonly copied: string }) =>
      navigator.clipboard.writeText(text),
    onSuccess: (_, { copied }) => toast.add({ title: copied }),
    onError: () =>
      toast.add({
        type: "error",
        title: "Couldn't copy",
        description: "This browser keeps the clipboard from pages served over plain http.",
      }),
  });
}
