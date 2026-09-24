import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { fakeIssuer } from "@via/codex-auth/testing";
import { Effect } from "effect";
import { HttpServer } from "effect/unstable/http";
import { runVia, tempHome } from "./helpers.ts";

/** A `via` runner with its own home, logging in against a local fake issuer. */
const withVia = <A, E, R>(
  body: (
    via: (...args: ReadonlyArray<string>) => ReturnType<typeof runVia>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const home = yield* tempHome;
    const issuer = yield* HttpServer.addressFormattedWith(Effect.succeed);
    return yield* body((...args) => runVia(home, args, { VIA_CODEX_ISSUER: issuer }));
  }).pipe(Effect.provide(fakeIssuer()));

layer(BunFileSystem.layer)("via accounts", (it) => {
  it.effect("add shows the device code, then saves the approved account", () =>
    withVia((via) =>
      Effect.gen(function* () {
        const added = yield* via("accounts", "add");
        expect(added.exitCode).toBe(0);
        expect(added.stdout).toContain("ABCD-1234");
        expect(added.stdout).toContain("/codex/device");
        expect(added.stdout).toContain("dev@example.com");
        expect((yield* via("accounts", "list")).stdout).toMatch(
          /dev@example\.com\s+dev@example\.com\s+pro\s+enabled/,
        );
      }),
    ),
  );

  it.effect("list explains how to add an account when there is none", () =>
    withVia((via) =>
      Effect.gen(function* () {
        expect((yield* via("accounts", "list")).stdout).toContain("via accounts add");
      }),
    ),
  );

  it.effect("label, disable and enable change what list shows", () =>
    withVia((via) =>
      Effect.gen(function* () {
        yield* via("accounts", "add");
        expect((yield* via("accounts", "label", "dev@example.com", "work")).exitCode).toBe(0);
        yield* via("accounts", "disable", "work");
        expect((yield* via("accounts", "list")).stdout).toMatch(
          /work\s+dev@example\.com\s+pro\s+disabled/,
        );
        yield* via("accounts", "enable", "work");
        expect((yield* via("accounts", "list")).stdout).toMatch(
          /work\s+dev@example\.com\s+pro\s+enabled/,
        );
      }),
    ),
  );

  it.effect("remove deletes the account", () =>
    withVia((via) =>
      Effect.gen(function* () {
        yield* via("accounts", "add");
        expect((yield* via("accounts", "remove", "dev@example.com")).exitCode).toBe(0);
        expect((yield* via("accounts", "list")).stdout).toContain("via accounts add");
      }),
    ),
  );

  it.effect("an unknown account fails with a message", () =>
    withVia((via) =>
      Effect.gen(function* () {
        const result = yield* via("accounts", "disable", "nobody");
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('No account with id, label or email "nobody"');
      }),
    ),
  );
});
