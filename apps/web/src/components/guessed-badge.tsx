import { Badge, Tooltip, VisuallyHidden } from "@via/ui";

const WHY =
  "Its client sent no conversation id, so via guessed which requests belong together from how the conversation opens. Two that open alike read as one.";

/** Marks a conversation via guessed, and says why on hover or focus; assistive tech reads why with it. */
export function GuessedBadge() {
  return (
    <Tooltip content={WHY}>
      <Badge color="amber" tabIndex={0}>
        Guessed
        <VisuallyHidden>: {WHY}</VisuallyHidden>
      </Badge>
    </Tooltip>
  );
}
