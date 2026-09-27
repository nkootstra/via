// Errors the admin API's contract names. They import only `effect`, so the contract
// bundles for a browser without the file-backed stores that raise them.
import { Schema } from "effect";

export class AccountNotFoundError extends Schema.TaggedError<AccountNotFoundError>()(
  "AccountNotFoundError",
  { query: Schema.String },
) {
  override get message() {
    return `No account with id, label or email "${this.query}"`;
  }
}

export class AuthRequestError extends Schema.TaggedError<AuthRequestError>()("AuthRequestError", {
  reason: Schema.String,
}) {
  override get message() {
    return `OpenAI auth request failed: ${this.reason}`;
  }
}
