// Errors the admin API's contract names. They import only `effect`, so the contract
// bundles for a browser without the key store that raises them.
import { Schema } from "effect";

export class DuplicateKeyNameError extends Schema.TaggedError<DuplicateKeyNameError>()(
  "DuplicateKeyNameError",
  { name: Schema.String },
) {
  override get message() {
    return `A key named "${this.name}" already exists`;
  }
}

export class KeyNotFoundError extends Schema.TaggedError<KeyNotFoundError>()("KeyNotFoundError", {
  idOrName: Schema.String,
}) {
  override get message() {
    return `No key with id or name "${this.idOrName}"`;
  }
}
