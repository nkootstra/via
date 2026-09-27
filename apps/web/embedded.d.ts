// The type of `dist/embedded.ts`, which `scripts/embed.ts` writes from the build.
// TypeScript can't read that file's `with { type: "file" }` imports of scripts
// and stylesheets, so importers see this instead, and need no build to typecheck.
import type { EmbeddedUi } from "@via/server";

/** The admin UI's build, for `ViaServer.layer({ ui })`. */
export declare const ui: EmbeddedUi;
