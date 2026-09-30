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

/** Ollama is set up in config.yaml, so the web UI can't change or remove it. */
export class OllamaNotEditableError extends Schema.TaggedError<OllamaNotEditableError>()(
  "OllamaNotEditableError",
  {},
) {
  override get message() {
    return "Ollama is set up in config.yaml: change its address there";
  }
}

/** An address given for Ollama isn't one via can use, and why. */
export class OllamaUnreachableError extends Schema.TaggedError<OllamaUnreachableError>()(
  "OllamaUnreachableError",
  { reason: Schema.String },
) {
  override get message() {
    return `Could not reach Ollama: ${this.reason}`;
  }
}

/** What was given as Ollama's address isn't an http or https address. */
export class OllamaAddressInvalidError extends Schema.TaggedError<OllamaAddressInvalidError>()(
  "OllamaAddressInvalidError",
  { address: Schema.String },
) {
  override get message() {
    return `"${this.address}" isn't an address: give Ollama's, such as http://192.168.1.20:11434`;
  }
}

/** OpenRouter refused an API key it was asked to check. */
export class OpenrouterKeyRejectedError extends Schema.TaggedError<OpenrouterKeyRejectedError>()(
  "OpenrouterKeyRejectedError",
  { status: Schema.Finite },
) {
  override get message() {
    return `OpenRouter refused this API key (HTTP ${this.status}); check that it is right`;
  }
}

/** OpenRouter could not be asked what via asked it. */
export class OpenrouterUnavailableError extends Schema.TaggedError<OpenrouterUnavailableError>()(
  "OpenrouterUnavailableError",
  { reason: Schema.String },
) {
  override get message() {
    return `Could not ask OpenRouter: ${this.reason}`;
  }
}

/** OpenRouter's key is set up in config.yaml, so the web UI can't change it. */
export class OpenrouterNotEditableError extends Schema.TaggedError<OpenrouterNotEditableError>()(
  "OpenrouterNotEditableError",
  {},
) {
  override get message() {
    return "OpenRouter is set up in config.yaml: change it there";
  }
}

/** OpenRouter has no key yet, so there is nothing to enable models of. */
export class OpenrouterNotSetUpError extends Schema.TaggedError<OpenrouterNotSetUpError>()(
  "OpenrouterNotSetUpError",
  {},
) {
  override get message() {
    return "Add an OpenRouter key first";
  }
}
