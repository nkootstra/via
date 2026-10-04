import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { BunFileSystem } from "@effect/platform-bun";

const here = import.meta.dirname;

const Manifest = Schema.fromJsonString(
  Schema.Struct({ libc: Schema.optionalKey(Schema.Array(Schema.String)) }),
);

// Bun's Linux binaries link glibc. Without `libc`, npm installs one on Alpine (musl) too,
// where it fails to start with a bare ENOENT instead of being skipped as unsupported.
it.effect.each(["via-linux-arm64", "via-linux-x64"])(
  "%s says it needs glibc, so npm skips it on musl",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const manifest = yield* Schema.decodeUnknownEffect(Manifest)(
        yield* fs.readFileString(`${here}/${platform}/package.json`),
      );

      expect(manifest.libc).toEqual(["glibc"]);
    }).pipe(Effect.provide(BunFileSystem.layer)),
);
