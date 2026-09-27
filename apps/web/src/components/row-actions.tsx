import { Button, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@via/ui";
import { EditIcon, MoreIcon, TrashIcon } from "./icons.tsx";

/**
 * A table row's "⋯" menu: rename it, or, set apart in red, remove it. Each
 * opens its dialog. `remove` names the removal, as "Remove" or "Revoke".
 */
export function RowActions({
  name,
  remove,
  onRename,
  onRemove,
}: {
  readonly name: string;
  readonly remove: string;
  readonly onRename: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button variant="ghost" size="icon-compact" aria-label={`Actions for ${name}`}>
            <MoreIcon size={16} />
          </Button>
        }
      />
      <MenuContent>
        <MenuItem label="Rename…" icon={<EditIcon size={15} />} onClick={onRename} />
        <MenuSeparator />
        <MenuItem
          label={`${remove}…`}
          icon={<TrashIcon size={15} />}
          destructive
          onClick={onRemove}
        />
      </MenuContent>
    </Menu>
  );
}
