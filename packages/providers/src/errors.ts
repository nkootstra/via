// Errors the admin API's contract names. They import only `effect`, so the contract
// bundles for a browser without the file-backed store and HTTP clients that raise them.
import { Schema } from "effect";

export class OpencodeGoAccountNotFoundError extends Schema.TaggedError<OpencodeGoAccountNotFoundError>()(
  "OpencodeGoAccountNotFoundError",
  { query: Schema.String },
) {
  override get message() {
    return `No OpenCode Go account with id or label "${this.query}"`;
  }
}

export class DuplicateOpencodeGoKeyError extends Schema.TaggedError<DuplicateOpencodeGoKeyError>()(
  "DuplicateOpencodeGoKeyError",
  { label: Schema.String },
) {
  override get message() {
    return `That OpenCode Go key is already stored, as "${this.label}"`;
  }
}

/** OpenCode Go refused an API key it was asked to check. */
export class OpencodeGoKeyRejectedError extends Schema.TaggedError<OpencodeGoKeyRejectedError>()(
  "OpencodeGoKeyRejectedError",
  { status: Schema.Finite },
) {
  override get message() {
    return `OpenCode Go refused this API key (HTTP ${this.status}); check that it is right`;
  }
}

/** OpenCode Go could not be asked to check an API key. */
export class OpencodeGoUnavailableError extends Schema.TaggedError<OpencodeGoUnavailableError>()(
  "OpencodeGoUnavailableError",
  { reason: Schema.String },
) {
  override get message() {
    return `Could not check the key with OpenCode Go: ${this.reason}`;
  }
}
