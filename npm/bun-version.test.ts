import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { BunFileSystem } from "@effect/platform-bun";

const root = `${import.meta.dirname}/..`;

const RootPackage = Schema.fromJsonString(
  Schema.Struct({
    packageManager: Schema.String,
    devDependencies: Schema.Struct({ "@types/bun": Schema.String }),
  }),
);

// `packageManager` is the one Bun version: CI installs it, and the Docker build
// image and Bun's types must follow it, or the image is built by a Bun nobody tested.
it.effect("builds the image and types against the Bun that package.json pins", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const pkg = yield* Schema.decodeUnknownEffect(RootPackage)(
      yield* fs.readFileString(`${root}/package.json`),
    );

    const dockerfile = yield* fs.readFileString(`${root}/Dockerfile`);

    const version = pkg.packageManager.replace(/^bun@/, "");
    expect(dockerfile).toMatch(new RegExp(`oven/bun:${version.replaceAll(".", "\\.")}@sha256:`));
    expect(pkg.devDependencies["@types/bun"]).toBe(`^${version}`);
  }).pipe(Effect.provide(BunFileSystem.layer)),
);
