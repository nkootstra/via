// The version of via this build of the admin UI belongs to: the CLI's, which
// `npm/set-version.ts` stamps on apps/cli/package.json before a release builds,
// read from that file as `apps/cli/src/version.ts` reads it, so it is never
// written by hand. The Vite and Vitest configs both hand it to the page.
import { readFileSync } from "node:fs";
import { Schema } from "effect";

const CliPackage = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

const { version } = Schema.decodeSync(CliPackage)(
  readFileSync(new URL("../cli/package.json", import.meta.url), "utf8"),
);

/** Defines `import.meta.env.VIA_VERSION`, which `src/version.ts` reads, for a Vite or Vitest config. */
export const viaVersion = { "import.meta.env.VIA_VERSION": JSON.stringify(version) };
