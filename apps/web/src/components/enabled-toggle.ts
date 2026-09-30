import { type DataTag, type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@via/ui";
import { useRef, useState } from "react";
import { refreshPool } from "../api/admin.ts";
import { useMask } from "../lib/privacy.ts";

interface Toggled {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
}

/**
 * Turns a row of the list `queryKey` holds on or off through `update`. The
 * switch flips at once and flips back, with a toast, if via refuses. A second
 * flip of a row still on its way is ignored, while other rows flip freely;
 * `busy` says which rows are on their way, for the switch's `aria-busy`.
 *
 * The flip is held beside the list rather than written into it: via pushes its
 * whole state as it changes, and a push landing mid-request would otherwise
 * flip the switch back until the next one.
 */
export function useEnabledToggle<Row extends Toggled>(
  queryKey: DataTag<QueryKey, ReadonlyArray<Row>, Error>,
  update: (id: string, payload: { readonly enabled: boolean }) => Promise<Row>,
) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const mask = useMask();
  // The ref guards against a second flip at once, before a render; the state
  // renders each row on its way as what it's turning into.
  const pending = useRef(new Map<string, boolean>());
  const [flipped, setFlipped] = useState<ReadonlyMap<string, boolean>>(new Map());
  const settle = () => setFlipped(new Map(pending.current));

  const mutation = useMutation({
    mutationFn: (row: Row) => update(row.id, { enabled: !row.enabled }),
    // The answer is the row as via now has it: in the list before the flip
    // lets go, so the switch doesn't flip back until the next push.
    onSuccess: (updated) =>
      queryClient.setQueryData(queryKey, (rows) =>
        rows?.map((row) => (row.id === updated.id ? updated : row)),
      ),
    onError: (error, row) =>
      toast.add({
        type: "error",
        title: `${row.enabled ? "Couldn't disable" : "Couldn't enable"} ${mask.key(row.label)}`,
        description: mask.key(error.message),
      }),
    onSettled: (_updated, _error, row) => {
      pending.current.delete(row.id);
      settle();
      refreshPool(queryClient);
    },
  });

  const toggle = (row: Row) => {
    if (pending.current.has(row.id)) return;
    pending.current.set(row.id, !row.enabled);
    settle();
    mutation.mutate(row);
  };

  return {
    toggle,
    /** Whether `row` is on, as it's turning into while on its way. */
    isOn: (row: Row) => flipped.get(row.id) ?? row.enabled,
    busy: (id: string) => flipped.has(id),
  };
}
